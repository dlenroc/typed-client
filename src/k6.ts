import http from "k6/http";
import type { FileData, Params, RequestBody, Response } from "k6/http";
import type { Endpoint } from "./core/endpoint-types.js";
import { transportError } from "./core/errors.js";
import type {
  BinaryInput,
  Fields,
  FieldScalar,
  MultipartFile,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  Transport,
  TransportResponse,
} from "./core/types.js";
import {
  appendResponseHeader,
  asBytes,
  createUrlResolver,
  defaultFileMediaType,
  defaultFilename,
  decodeMultipart,
  decodeUrlEncoded,
  decodeUtf8,
  encodeFields,
  encodeJson,
  encodeUtf8,
  forEachField,
  prepareHeaders,
} from "./http.js";

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

export interface K6ResponseMetadata {
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

/**
 * Passed to k6 as params. `redirects` here overrides `follow`.
 * `timeout` here overrides `timeout`.
 */
type K6NativeOptions = Omit<Params, "headers" | "responseType">;

function toK6ArrayBuffer(data: BinaryInput) {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  const bytes = asBytes(data);

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

/** Whether a part is a k6 `http.file()` value. */
function isK6File(part: FileData | MultipartFile): part is FileData {
  return "content_type" in part || typeof part.data === "string";
}

// Keep a quoted header parameter on one line and inside its quotes.
function escapeQuoted(text: string) {
  return text.replaceAll('"', "%22").replace(/[\r\n]/g, "");
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
    const escapedName = escapeQuoted(name);

    if (typeof value === "string") {
      add(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapedName}"\r\n\r\n${value}\r\n`,
      );

      return;
    }

    const mediaType =
      (isK6File(value) ? value.content_type : value.mediaType) ?? defaultFileMediaType;

    const filename = escapeQuoted(value.filename ?? defaultFilename);

    add(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapedName}"; filename="${filename}"\r\n` +
        `Content-Type: ${mediaType}\r\n\r\n`,
    );
    add(typeof value.data === "string" ? value.data : asBytes(value.data));
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

  // Replay the parts collected so far into a manual encoder.
  function switchToManual() {
    const encoder = manualMultipart();
    for (let i = 0; i < fieldNames.length; i++) {
      const name = fieldNames[i]!;
      encoder.append(name, nativeParts[name]!);
    }

    return encoder;
  }

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
      manualEncoder = switchToManual();
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
    manualEncoder = switchToManual();
  }

  if (manualEncoder !== undefined) {
    return manualEncoder.finish();
  }

  for (let i = 0; i < fieldNames.length; i++) {
    const name = fieldNames[i]!;
    const part = nativeParts[name]!;

    if (typeof part === "object" && !isK6File(part)) {
      nativeParts[name] = httpApi.file(
        toK6ArrayBuffer(part.data),
        part.filename ?? defaultFilename,
        part.mediaType ?? defaultFileMediaType,
      );
    }
  }

  return { body: nativeParts };
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

    // k6 joins repeated values itself and gives canonical names, for example
    // `Content-Type`.
    const nativeHeaders = native.headers;
    const names = Object.keys(nativeHeaders);
    const headers: Record<string, string> = Object.create(null);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      appendResponseHeader(headers, name, nativeHeaders[name]!);
    }

    this.headers = headers;

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

  async read<Kind extends keyof ResponseKindMap>(
    kind: Kind,
  ): Promise<ResponseKindMap[Kind]> {
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

type CaptureMode = "none" | "text" | "binary";

function captureMode(endpoint: Endpoint): CaptureMode {
  const responses = endpoint.responses;
  const statuses = Object.keys(responses);
  let mode: CaptureMode = "none";

  for (let i = 0; i < statuses.length; i++) {
    const kind = responses[statuses[i] as `${number}`]!.body.kind;
    if (kind === "binary" || kind === "multipart") {
      return "binary";
    }

    if (kind !== "none") {
      mode = "text";
    }
  }

  return mode;
}

/** The transport that {@link k6Transport} returns. */
export type K6Transport = Transport<
  K6RequestKinds,
  ResponseKindMap,
  K6NativeOptions,
  K6ResponseMetadata
>;

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
): K6Transport {
  const httpApi = config.http ?? http;
  const resolveUrl = createUrlResolver(config.baseUrl);

  return async (request) => {
    const url = resolveUrl(request);
    let prepared = false;

    try {
      const selected =
        request.headers === undefined && request.body === undefined
          ? undefined
          : prepareHeaders(request.headers, request.bodyKind, request.body !== undefined);
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
            // k6 accepts byte views even though RequestBody omits them. It
            // sends a `DataView` as an empty body, and other views that are
            // not a `Uint8Array` fail or send wrong bytes.
            body = (
              request.body instanceof ArrayBuffer
                ? request.body
                : asBytes(request.body as BinaryInput)
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
              selected!.contentType === undefined &&
              !contentTypeSuppressed &&
              multipart.contentType !== undefined
            ) {
              selected!.fields["content-type"] = multipart.contentType;
            }

            break;
          }

          default:
            throw new TypeError(`Unsupported request body kind: ${String(request.bodyKind)}`);
        }
      }

      const responseType = request.discard ? "none" : captureMode(request.endpoint);
      const native = request.options;
      const params: Record<string, unknown> =
        native === undefined ? { responseType } : { ...native, headers: undefined, responseType };

      if (request.timeout !== undefined && params.timeout === undefined) {
        params.timeout = request.timeout;
      }

      if (!request.follow && params.redirects === undefined) {
        params.redirects = 0;
      }

      if (selected !== undefined) {
        params.headers = selected.fields;
      }

      prepared = true;
      const response = await httpApi.asyncRequest(request.method, url, body, params as Params);
      return new K6ResponseHandle(response as unknown as K6Response);
    } catch (failure) {
      throw transportError(prepared ? "transport" : "request", request, failure, url);
    }
  };
}
