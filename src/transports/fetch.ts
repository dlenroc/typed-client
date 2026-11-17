import type {
  CommonOptions,
  MultipartResponse,
  MultipartResponseValue,
  RequestKindMap,
  ResponseKindMap,
  ResponseHeaders,
  Transport,
  TransportResponse,
} from "../core/types.js";
import { asSearchParams } from "../shared/fields.js";
import { transportError } from "../core/errors.js";
import { asFormData, encodeJson } from "./body.js";
import { prepareHeaders, appendResponseHeader } from "./headers.js";
import { createUrlResolver } from "../shared/url.js";
import { decodeUrlEncoded, encodeUtf8 } from "./codec.js";

interface FetchRequestKinds extends RequestKindMap {
  /**
   * A `Blob` or `File`. Fetch uses its `type`, if not empty, as the default
   * `Content-Type`.
   */
  readonly blob: Blob;

  /**
   * A `ReadableStream` of bytes. Fetch reads the stream once while it sends
   * the body. With `follow: true`, a redirect other than 303 fails.
   */
  readonly stream: ReadableStream<Uint8Array>;
}

interface FetchResponseKinds extends ResponseKindMap {
  readonly blob: Blob;
  readonly stream: ReadableStream<Uint8Array>;
}

interface FetchMetadata {
  readonly redirected: boolean;
  readonly type: ResponseType;
}

type FetchNativeOptions = CommonOptions & {
  /**
   * Passed to `fetch`. `redirect` here overrides `follow`. The client
   * combines `signal` here with `timeout`.
   */
  readonly transport?: Omit<RequestInit, "method" | "headers" | "body">;
};

async function decodeFormData(form: FormData): Promise<MultipartResponse> {
  const target: Record<string, MultipartResponseValue | MultipartResponseValue[]> =
    Object.create(null);

  for (const [name, item] of form) {
    let value: MultipartResponseValue;
    if (typeof item === "string") {
      value = item;
    } else {
      value = {
        data: new Uint8Array(await item.arrayBuffer()),
        filename: item.name,
        mediaType: item.type,
      };
    }

    const previous = target[name];
    if (previous === undefined) {
      target[name] = value;
    } else if (Array.isArray(previous)) {
      previous.push(value);
    } else {
      target[name] = [previous, value];
    }
  }

  return target;
}

class FetchResponseHandle implements TransportResponse<FetchResponseKinds, FetchMetadata> {
  readonly status: number;
  readonly url: string;
  readonly headers: ResponseHeaders;
  readonly transport: FetchMetadata;
  private state: "unread" | "read" | "stream" = "unread";

  constructor(private readonly native: Response) {
    this.status = native.status;
    this.url = native.url;
    this.transport = { redirected: native.redirected, type: native.type };

    // Iteration gives each Set-Cookie value separately.
    const headers: Record<string, string | string[]> = Object.create(null);
    for (const [name, value] of native.headers) {
      appendResponseHeader(headers, name, value);
    }

    this.headers = headers;
  }

  async read<Kind extends keyof FetchResponseKinds>(kind: Kind): Promise<FetchResponseKinds[Kind]> {
    if (this.state !== "unread") {
      throw new TypeError("Response has already been read");
    }

    this.state = "read";

    const response = this.native;

    if (kind === "none") {
      const stream = response.body;
      if (stream !== null) {
        const reader = stream.getReader();
        try {
          while (!(await reader.read()).done) {
            // Drain without buffering so the connection can be reused.
          }
        } finally {
          reader.releaseLock();
        }
      }

      return undefined as never;
    }

    if (kind === "text") {
      return (await response.text()) as never;
    }

    if (kind === "json") {
      return (await response.json()) as never;
    }

    if (kind === "binary") {
      return new Uint8Array(await response.arrayBuffer()) as never;
    }

    if (kind === "urlencoded") {
      return decodeUrlEncoded(await response.text()) as never;
    }

    if (kind === "multipart") {
      return (await decodeFormData(await response.formData())) as never;
    }

    if (kind === "blob") {
      return (await response.blob()) as never;
    }

    if (kind === "stream") {
      const stream = response.body;
      if (stream === null) {
        throw new TypeError("Response stream is unavailable");
      }

      this.state = "stream";
      return stream as never;
    }

    throw new TypeError(`Unsupported response kind: ${String(kind)}`);
  }

  async discard() {
    if (this.state === "unread") {
      await this.read("none");
    } else if (this.state === "stream") {
      this.state = "read";
      await this.native.body?.cancel();
    }
  }
}

/**
 * Send requests with the Fetch API of a browser or Node.js 24+.
 *
 * @remarks
 * Do not send a body with `GET` or `HEAD`. Pass native options such as
 * `signal` under `transport`. This transport also decodes `blob` and
 * `stream` responses. Consume or cancel returned streams. A stream
 * schema must release its reader lock before it returns or throws.
 * If the schema replaces the stream, consume or cancel the original.
 * Browser CORS and forbidden-header restrictions apply.
 *
 * @example
 * ```ts
 * import { c } from "@dlenroc/typed-client";
 * import { fetchTransport } from "@dlenroc/typed-client/fetch";
 *
 * const transport = fetchTransport({ baseUrl: "https://api.example.test" });
 * const health = c.bind(c.endpoint("/health"), transport);
 * await health({ status: 204, timeout: 5000 });
 * ```
 *
 * @throws
 * A {@link TypeError} if no Fetch implementation is available.
 */
export function fetchTransport(
  config: {
    /** Relative endpoints append to this URL's path. */
    readonly baseUrl?: string;

    /** @defaultValue globalThis.fetch */
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Transport<FetchRequestKinds, FetchResponseKinds, FetchNativeOptions, FetchMetadata> {
  const fetch = config.fetch ?? globalThis.fetch;
  const resolveUrl = createUrlResolver(config.baseUrl);

  if (typeof fetch !== "function") {
    throw new TypeError("Fetch API is unavailable");
  }

  return async (request) => {
    const url = resolveUrl(request.url);
    let prepared = false;

    try {
      let body: BodyInit | undefined;
      const input = request.input;
      const native = input?.transport;
      // DOM `RequestInit` has no `duplex`, which a stream body needs.
      const options: RequestInit & { duplex?: "half" } = { ...native, method: request.method };
      if (native !== undefined) {
        delete options.headers;
        delete options.body;
      }

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
          case "blob":
            body = request.body as BodyInit;
            break;

          case "urlencoded": {
            const fields = request.body as RequestKindMap["urlencoded"];
            body = typeof fields === "string" ? fields : asSearchParams(fields);
            break;
          }

          case "multipart":
            body = asFormData(request.body as RequestKindMap["multipart"]);
            break;

          case "stream":
            body = request.body as FetchRequestKinds["stream"];
            options.duplex = "half";
            break;

          default:
            throw new TypeError(`Unsupported request body kind: ${String(request.bodyKind)}`);
        }
      }

      const headers = request.headers;
      if (headers !== undefined || body !== undefined) {
        const selected = prepareHeaders(
          headers,
          request.bodyKind,
          body !== undefined,
          input?.unchecked === true,
        );

        if (selected.contentTypeSuppressed) {
          // Fetch leaves Content-Type unset for byte bodies.
          if (typeof body === "string" || body instanceof URLSearchParams) {
            body = encodeUtf8(body.toString()) as BodyInit;
          } else if (body instanceof FormData) {
            body = await new Response(body).arrayBuffer();
          } else if (body instanceof Blob) {
            // A slice has an empty type and shares the data without a copy.
            body = body.slice();
          }
        }

        // A plain record keeps the caller's header name case.
        options.headers = selected.fields;
      }

      if (body !== undefined) {
        options.body = body;
      }

      if (options.redirect === undefined) {
        options.redirect = input?.follow === true ? "follow" : "manual";
      }

      const timeout = input?.timeout;
      if (timeout !== undefined) {
        const limit = AbortSignal.timeout(timeout);
        options.signal = options.signal ? AbortSignal.any([options.signal, limit]) : limit;
      }

      prepared = true;
      const response = await fetch(url, options);
      return new FetchResponseHandle(response);
    } catch (failure) {
      throw transportError(prepared, request.method, url, request.meta, failure);
    }
  };
}
