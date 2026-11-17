import type { FileData, Params, RequestBody, Response } from "k6/http";
import http from "k6/http";
import { transportError } from "../core/errors.js";
import type {
  BinaryInput,
  CommonOptions,
  FieldScalar,
  Fields,
  MultipartFile,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  Transport,
  TransportResponse,
} from "../core/types.js";
import { encodeFields, forEachField } from "../shared/fields.js";
import { createUrlResolver } from "../shared/url.js";
import { binaryView, encodeJson } from "./body.js";
import { decodeMultipart, decodeUrlEncoded, decodeUtf8, encodeUtf8 } from "./codec.js";
import { prepareHeaders } from "./headers.js";

interface K6RequestKinds extends Omit<RequestKindMap, "multipart"> {
  readonly multipart: Fields<FieldScalar | MultipartFile | FileData>;
}

type K6Http = Pick<typeof import("k6/http"), "asyncRequest" | "file">;

/** A cookie that k6 parsed from `Set-Cookie`, with the k6 field names. */
interface K6Cookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly http_only: boolean;
  readonly secure: boolean;
  readonly max_age: number;
  readonly expires: number;
}

/**
 * The k6 response as k6 gives it. `@types/k6` names two cookie fields
 * `httpOnly` and `maxAge`, and its `tls_cipher_suite` type has no `""`.
 */
type K6Response = Omit<Response, "cookies" | "tls_cipher_suite"> & {
  readonly cookies: Readonly<Record<string, readonly K6Cookie[]>>;
  readonly tls_cipher_suite: Response["tls_cipher_suite"] | "";
};

interface K6ResponseMetadata {
  /** Parsed `Set-Cookie` values by cookie name. */
  readonly cookies: K6Response["cookies"];
  readonly timings: K6Response["timings"];
  readonly proto: K6Response["proto"];
  readonly remote_ip: K6Response["remote_ip"];
  readonly remote_port: K6Response["remote_port"];

  /** The TLS version, or `""` if the connection does not use TLS. */
  readonly tls_version: K6Response["tls_version"];

  /** The TLS cipher suite, or `""` if the connection does not use TLS. */
  readonly tls_cipher_suite: K6Response["tls_cipher_suite"];
  readonly error: K6Response["error"];
  readonly error_code: K6Response["error_code"];
}

type K6Part = string | FileData | MultipartFile;

type K6NativeOptions = CommonOptions & {
  /**
   * Passed to k6 as params. `redirects` here overrides `follow`.
   * `timeout` here overrides `timeout`.
   */
  readonly transport?: Omit<Params, "headers" | "responseType">;
};

function toK6ArrayBuffer(data: BinaryInput) {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  const bytes = binaryView(data);

  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }

  // http.file requires an ArrayBuffer, so copy only the selected bytes.
  return bytes.slice().buffer;
}

function manualMultipart() {
  const boundary = "typed-client-" + Math.random().toString(36).slice(2);
  const chunks: (string | Uint8Array)[] = [];
  let hasBinary = false;

  function add(value: string | Uint8Array) {
    if (typeof value !== "string") {
      hasBinary = true;
      chunks.push(value);
    } else if (typeof chunks[chunks.length - 1] === "string") {
      chunks[chunks.length - 1] += value;
    } else {
      chunks.push(value);
    }
  }

  function append(name: string, value: K6Part) {
    const escapedName = name.replaceAll('"', "%22").replace(/[\r\n]/g, "");

    if (typeof value === "string") {
      add(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapedName}"\r\n\r\n${value}\r\n`,
      );

      return;
    }

    const native = "content_type" in value || typeof value.data === "string";
    const filename = (value.filename ?? "blob")
      .replaceAll('"', "%22")
      .replace(/[\r\n]/g, "");
    const mediaType = native
      ? ((value as FileData).content_type ?? "application/octet-stream")
      : ((value as MultipartFile).mediaType ?? "application/octet-stream");

    add(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapedName}"; filename="${filename}"\r\n` +
        `Content-Type: ${mediaType}\r\n\r\n`,
    );
    add(typeof value.data === "string" ? value.data : binaryView(value.data));
    add("\r\n");
  }

  function finish() {
    add(`--${boundary}--\r\n`);
    const contentType = `multipart/form-data; boundary=${boundary}`;

    if (!hasBinary) {
      return { body: chunks.join(""), contentType };
    }

    const encodedChunks: Uint8Array[] = [];
    let length = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const bytes = typeof chunk === "string" ? encodeUtf8(chunk) : chunk;
      encodedChunks.push(bytes);
      length += bytes.byteLength;
    }

    const encoded = new Uint8Array(length);
    let offset = 0;

    for (let i = 0; i < encodedChunks.length; i++) {
      const chunk = encodedChunks[i]!;
      encoded.set(chunk, offset);
      offset += chunk.length;
    }

    return { body: encoded.buffer, contentType };
  }

  return { append, finish };
}

function k6Multipart(
  body: K6RequestKinds["multipart"],
  httpApi: K6Http,
  forceManual: boolean,
): { body: Record<string, unknown> | string | ArrayBuffer; contentType?: string } {
  const nativeParts: Record<string, K6Part> = Object.create(null);
  const fieldNames: string[] = [];
  let manualEncoder = forceManual ? manualMultipart() : undefined;
  let containsFile = false;

  forEachField(body, (name, value) => {
    if (value === undefined) {
      return;
    }

    const part = value === null ? "" : typeof value === "object" ? value : String(value);

    if (typeof part !== "string") {
      containsFile = true;
    }

    // k6's native multipart object keeps only one value per name.
    if (manualEncoder === undefined && nativeParts[name] !== undefined) {
      manualEncoder = manualMultipart();
      for (let i = 0; i < fieldNames.length; i++) {
        const priorName = fieldNames[i]!;
        manualEncoder.append(priorName, nativeParts[priorName]!);
      }
    }

    if (manualEncoder !== undefined) {
      manualEncoder.append(name, part);
    } else {
      nativeParts[name] = part;
      fieldNames.push(name);
    }
  });

  // k6 encodes text-only objects as URL-encoded data.
  if (manualEncoder === undefined && !containsFile) {
    manualEncoder = manualMultipart();
    for (let i = 0; i < fieldNames.length; i++) {
      const name = fieldNames[i]!;
      manualEncoder.append(name, nativeParts[name]!);
    }
  }

  if (manualEncoder !== undefined) {
    return manualEncoder.finish();
  }

  for (let i = 0; i < fieldNames.length; i++) {
    const name = fieldNames[i]!;
    const part = nativeParts[name]!;
    if (
      typeof part === "object" &&
      !("content_type" in part || typeof part.data === "string")
    ) {
      nativeParts[name] = httpApi.file(
        toK6ArrayBuffer(part.data as BinaryInput),
        part.filename ?? "blob",
        (part as MultipartFile).mediaType ?? "application/octet-stream",
      );
    }
  }

  return { body: nativeParts };
}

function normalizeHeaders(source: Record<string, string | readonly string[]>): ResponseHeaders {
  const target: Record<string, string | readonly string[]> = Object.create(null);

  for (const name in source) {
    const key = name.toLowerCase();
    const value = source[name]!;
    const previous = target[key];

    if (previous === undefined) {
      target[key] = value;
    } else {
      const combined = typeof previous === "string" ? [previous] : [...previous];
      if (typeof value === "string") {
        combined.push(value);
      } else {
        for (let i = 0; i < value.length; i++) {
          const part = value[i]!;
          combined.push(part);
        }
      }

      target[key] = combined;
    }
  }

  return target;
}

class K6ResponseHandle implements TransportResponse<ResponseKindMap, K6ResponseMetadata> {
  readonly status: number;
  readonly url: string;
  readonly headers: ResponseHeaders;
  readonly transport: K6ResponseMetadata;
  private consumed = false;

  constructor(private readonly native: K6Response) {
    this.status = native.status;
    this.url = native.url;
    this.headers = normalizeHeaders(native.headers);

    // The native `cookies` and `timings` objects retain the response body.
    // The cookie lists do not retain it, so a new record reuses them.
    const nativeCookies = native.cookies;
    const cookies: Record<string, readonly K6Cookie[]> = Object.create(null);
    for (const name in nativeCookies) {
      cookies[name] = nativeCookies[name]!;
    }

    const timings = native.timings;
    this.transport = {
      cookies,
      timings: {
        blocked: timings.blocked,
        connecting: timings.connecting,
        tls_handshaking: timings.tls_handshaking,
        sending: timings.sending,
        waiting: timings.waiting,
        receiving: timings.receiving,
        duration: timings.duration,
      },
      proto: native.proto,
      remote_ip: native.remote_ip,
      remote_port: native.remote_port,
      tls_version: native.tls_version,
      tls_cipher_suite: native.tls_cipher_suite,
      error: native.error,
      error_code: native.error_code,
    };
  }

  async read<Kind extends keyof ResponseKindMap>(kind: Kind): Promise<ResponseKindMap[Kind]> {
    if (this.consumed) {
      throw new TypeError("Response has already been read");
    }

    this.consumed = true;

    if (kind === "none") {
      return undefined as never;
    }

    if (kind === "json") {
      return this.native.json() as never;
    }

    const captured = this.native.body;
    if (captured === null) {
      throw new TypeError("k6 discarded the response body");
    }

    if (kind === "binary" || kind === "multipart") {
      if (!(captured instanceof ArrayBuffer)) {
        throw new TypeError("k6 did not capture the binary response body");
      }

      const bytes = new Uint8Array(captured);
      return (
        kind === "binary" ? bytes : decodeMultipart(bytes, this.headers["content-type"])
      ) as never;
    }

    const text = typeof captured === "string" ? captured : decodeUtf8(captured);
    if (kind === "text") {
      return text as never;
    }

    if (kind === "urlencoded") {
      return decodeUrlEncoded(text) as never;
    }

    throw new TypeError(`Unsupported response kind: ${String(kind)}`);
  }
}

/**
 * Send requests with `k6/http`.
 *
 * @remarks
 * Use k6 2.2 or later and add `@types/k6` for TypeScript. k6 does not
 * load npm packages directly. Bundle the script first. The transport
 * captures response bodies only for the expected response kinds.
 * Multipart fields accept `http.file()` values.
 *
 * @example
 * ```ts
 * import { c } from "@dlenroc/typed-client";
 * import { k6Transport } from "@dlenroc/typed-client/k6";
 *
 * const transport = k6Transport({ baseUrl: "https://api.example.test" });
 * const health = c.bind(c.endpoint("/health"), transport);
 *
 * export default async function () {
 *   await health({ status: 204, transport: { tags: { name: "health" } } });
 * }
 * ```
 *
 * @see {@link https://grafana.com/docs/k6/latest/using-k6/modules/ | Modules}
 */
export function k6Transport(
  config: {
    /** Relative endpoints append to this URL's path. */
    readonly baseUrl?: string;

    /** @defaultValue The `k6/http` module */
    readonly http?: K6Http;
  } = {},
): Transport<K6RequestKinds, ResponseKindMap, K6NativeOptions, K6ResponseMetadata> {
  const httpApi = config.http ?? http;
  const resolveUrl = createUrlResolver(config.baseUrl);

  return async (request) => {
    const url = resolveUrl(request.url);
    let prepared = false;

    try {
      const input = request.input;
      const selected =
        request.headers === undefined && request.body === undefined
          ? undefined
          : prepareHeaders(
              request.headers,
              request.bodyKind,
              request.body !== undefined,
              input?.unchecked === true,
            );
      const contentTypeSuppressed = selected?.contentTypeSuppressed === true;

      let body: RequestBody | null = null;

      if (request.body !== undefined) {
        switch (request.bodyKind) {
          case "none":
            throw new TypeError("Request body kind none does not allow a body");

          case "json":
            body = encodeJson(request.body);
            break;

          case "text":
            body = request.body as string;
            break;

          case "binary":
            // k6 accepts byte views even though RequestBody omits them.
            body = (
              request.body instanceof ArrayBuffer
                ? request.body
                : binaryView(request.body as BinaryInput)
            ) as RequestBody;
            break;

          case "urlencoded":
            body = encodeFields(request.body as RequestKindMap["urlencoded"]);
            break;

          case "multipart": {
            const multipart = k6Multipart(
              request.body as K6RequestKinds["multipart"],
              httpApi,
              contentTypeSuppressed,
            );
            body = multipart.body as RequestBody;

            // The manual encoder chose the boundary, so send its header.
            if (
              selected !== undefined &&
              selected.contentType === undefined &&
              !contentTypeSuppressed &&
              multipart.contentType !== undefined
            ) {
              selected.fields["content-type"] = multipart.contentType;
            }
            break;
          }

          default:
            throw new TypeError(`Unsupported request body kind: ${String(request.bodyKind)}`);
        }
      }

      let responseType: "none" | "text" | "binary" = "none";
      const kinds = request.responseKinds;
      for (let i = 0; i < kinds.length; i++) {
        const kind = kinds[i];
        if (kind === "binary" || kind === "multipart") {
          responseType = "binary";
          break;
        }

        if (kind !== "none") {
          responseType = "text";
        }
      }

      const native = input?.transport;
      const params: Record<string, unknown> =
        native === undefined ? { responseType } : { ...native, headers: undefined, responseType };

      const timeout = input?.timeout;
      if (timeout !== undefined && params.timeout === undefined) {
        params.timeout = timeout;
      }

      if (input?.follow !== true && (native === undefined || params.redirects === undefined)) {
        params.redirects = 0;
      }

      if (selected !== undefined) {
        params.headers = selected.fields;
      }

      prepared = true;
      const response = await httpApi.asyncRequest(request.method, url, body, params as Params);
      return new K6ResponseHandle(response as unknown as K6Response);
    } catch (failure) {
      throw transportError(prepared, request.method, url, request.meta, failure);
    }
  };
}
