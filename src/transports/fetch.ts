import type {
  MultipartResponse,
  MultipartResponseValue,
  RequestKindMap,
  ResponseKindMap,
  ResponseHeaders,
  Transport,
  TransportResponse,
} from "../core/types.js";
import { asSearchParams } from "../shared/fields.js";
import { RequestPreparationError, TransportFailure } from "../core/errors.js";
import { asFormData, binaryView, encodeJson } from "./body.js";
import { prepareHeaders, appendResponseHeader, defaultContentType } from "./headers.js";
import { createUrlResolver } from "../shared/url.js";
import { decodeUrlEncoded, encodeUtf8 } from "./codec.js";

interface FetchResponseKinds extends ResponseKindMap {
  readonly blob: Blob;
  readonly stream: ReadableStream<Uint8Array>;
}

interface FetchMetadata {
  readonly redirected: boolean;
  readonly type: ResponseType;
}

const NATIVE_OPTION_KEYS = [
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "priority",
  "window",
] as const;

type FetchNativeOptions = Pick<RequestInit, (typeof NATIVE_OPTION_KEYS)[number]>;

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

    const headers: Record<string, string | string[]> = Object.create(null);
    for (const [name, value] of native.headers) {
      appendResponseHeader(headers, name, value);
    }

    // Header iteration can combine Set-Cookie values.
    const cookies = native.headers.getSetCookie?.();
    if (cookies?.length) {
      headers["set-cookie"] = cookies;
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

    throw new TypeError(`Unsupported Fetch response body kind: ${String(kind)}`);
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
 * Use the browser's Fetch API or Node.js 24+.
 *
 * @remarks
 * Leave the body absent for GET and HEAD. Pass native options such as
 * `signal` in the call object. This adapter also decodes `blob` and
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
 * await health({ status: 204, signal: AbortSignal.timeout(5000) });
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
): Transport<RequestKindMap, FetchResponseKinds, FetchNativeOptions, FetchMetadata> {
  const fetch = config.fetch ?? globalThis.fetch;
  const resolveUrl = createUrlResolver(config.baseUrl);

  if (typeof fetch !== "function") {
    throw new TypeError("Fetch API is unavailable");
  }

  return async (request) => {
    const url = resolveUrl(request.url);

    try {
      let body: BodyInit | undefined;
      const options: RequestInit = { method: request.method };

      try {
        if (request.body !== undefined) {
          switch (request.bodyKind) {
            case "none":
              throw new RequestPreparationError("none request body kind cannot have a body");

            case "json":
              body = encodeJson(request.body);
              break;

            case "text":
              body = request.body as string;
              break;

            case "binary":
              body = binaryView(request.body as RequestKindMap["binary"]) as BodyInit;
              break;

            case "urlencoded": {
              const fields = request.body as RequestKindMap["urlencoded"];
              body = typeof fields === "string" ? fields : asSearchParams(fields);
              break;
            }

            case "multipart":
              body = asFormData(request.body as RequestKindMap["multipart"]);
              break;

            default:
              throw new RequestPreparationError(
                `Unsupported Fetch request body kind: ${String(request.bodyKind)}`,
              );
          }
        }

        const headers = request.headers;
        const useMultipartBoundary =
          request.bodyKind === "multipart" &&
          body !== undefined &&
          request.input?.unchecked !== true;
        if (headers instanceof Headers) {
          options.headers = headers;
          const contentType = body === undefined ? undefined : defaultContentType(request.bodyKind);

          if (useMultipartBoundary && headers.has("content-type")) {
            const preparedHeaders = new Headers(headers);
            preparedHeaders.delete("content-type");
            options.headers = preparedHeaders;
          } else if (contentType !== undefined && !headers.has("content-type")) {
            const preparedHeaders = new Headers(headers);
            preparedHeaders.set("content-type", contentType);
            options.headers = preparedHeaders;
          }
        } else if (headers !== undefined || body !== undefined) {
          let suppressContentType = false;
          const rawHeaders = prepareHeaders(
            headers,
            request.bodyKind,
            body !== undefined,
            (suppressed) => {
              suppressContentType = suppressed;
            },
          );

          if (useMultipartBoundary) {
            delete rawHeaders["content-type"];
          }

          if (suppressContentType) {
            // Fetch leaves Content-Type unset for byte bodies.
            if (typeof body === "string" || body instanceof URLSearchParams) {
              body = encodeUtf8(body.toString()) as BodyInit;
            } else if (body instanceof FormData) {
              try {
                body = await new Response(body).arrayBuffer();
              } catch (cause) {
                throw new RequestPreparationError(
                  "Failed to encode multipart body without Content-Type",
                  { cause },
                );
              }
            }
          }

          const preparedHeaders = new Headers();
          for (const key in rawHeaders) {
            const value = rawHeaders[key]!;
            if (typeof value === "string") {
              preparedHeaders.append(key, value);
            } else {
              for (const part of value) {
                preparedHeaders.append(key, part);
              }
            }
          }
          options.headers = preparedHeaders;
        }

        if (body !== undefined) {
          options.body = body;
        }

        for (const key of NATIVE_OPTION_KEYS) {
          const value = request.input?.[key];
          if (value !== undefined) {
            (options as Record<string, unknown>)[key] = value;
          }
        }
      } catch (cause) {
        if (cause instanceof RequestPreparationError) {
          throw cause;
        }

        throw new RequestPreparationError("Failed to prepare Fetch request", { cause });
      }

      const response = await fetch(url, options);
      return new FetchResponseHandle(response);
    } catch (cause) {
      throw new TransportFailure(url, cause);
    }
  };
}
