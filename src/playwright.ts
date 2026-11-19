import { Buffer } from "node:buffer";
import type { APIRequestContext, APIResponse } from "playwright-core";
import { FailureWithCleanupError, ResponseCleanupError, AdapterFailure } from "./core/errors.js";
import type {
  BinaryInput,
  Reference,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  Transport,
  TransportResponse,
} from "./core/types.js";
import {
  appendResponseHeader,
  asBytes,
  asFormData,
  createUrlResolver,
  defaultFileMediaType,
  defaultFilename,
  decodeMultipart,
  decodeUrlEncoded,
  encodeFields,
  encodeJson,
  isMultipartFile,
  prepareHeaders,
} from "./http.js";

export interface PlaywrightMetadata {
  readonly timing: ReturnType<APIResponse["timing"]>;

  /**
   * The server IP address and port, or `null` if Playwright does not know
   * them.
   */
  readonly serverAddr: Awaited<ReturnType<APIResponse["serverAddr"]>>;

  /**
   * The TLS certificate and protocol, or `null` for a response that is not
   * HTTPS.
   */
  readonly securityDetails: Awaited<ReturnType<APIResponse["securityDetails"]>>;
}

type PlaywrightContext = Pick<APIRequestContext, "fetch">;

type PlaywrightFetchOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;

/** Passed to `fetch`. `maxRedirects` here overrides `follow`. */
type PlaywrightNativeOptions = Pick<
  PlaywrightFetchOptions,
  "maxRedirects" | "maxRetries" | "ignoreHTTPSErrors" | "signal"
>;

async function disposeAfterFailure(response: APIResponse, cause: unknown): Promise<never> {
  try {
    await response.dispose();
  } catch (cleanupError) {
    throw new FailureWithCleanupError(cause, cleanupError);
  }

  throw cause;
}

class PlaywrightResponseHandle implements TransportResponse<ResponseKindMap, PlaywrightMetadata> {
  readonly status: number;
  readonly url: string;
  private consumed = false;

  private constructor(
    private readonly native: APIResponse,
    readonly headers: ResponseHeaders,
    readonly transport: PlaywrightMetadata,
  ) {
    this.status = native.status();
    this.url = native.url();
  }

  static async create(native: APIResponse) {
    try {
      const headers: Record<string, string> = Object.create(null);
      const entries = native.headersArray();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        appendResponseHeader(headers, entry.name, entry.value);
      }

      const [serverAddr, securityDetails] = await Promise.all([
        native.serverAddr(),
        native.securityDetails(),
      ]);

      return new PlaywrightResponseHandle(native, headers, {
        timing: native.timing(),
        serverAddr,
        securityDetails,
      });
    } catch (cause) {
      return disposeAfterFailure(native, cause);
    }
  }

  async read<Kind extends keyof ResponseKindMap>(
    kind: Kind,
  ): Promise<ResponseKindMap[Kind]> {
    if (this.consumed) {
      throw new TypeError("Response has already been read");
    }

    this.consumed = true;
    let result: unknown;

    try {
      if (kind === "none") {
        result = undefined;
      } else if (kind === "text") {
        result = await this.native.text();
      } else if (kind === "json") {
        result = await this.native.json();
      } else if (kind === "binary") {
        result = await this.native.body();
      } else if (kind === "urlencoded") {
        result = decodeUrlEncoded(await this.native.text());
      } else if (kind === "multipart") {
        result = decodeMultipart(await this.native.body(), this.headers["content-type"]);
      } else {
        throw new TypeError(`Unsupported response kind: ${String(kind)}`);
      }
    } catch (cause) {
      return disposeAfterFailure(this.native, cause);
    }

    try {
      await this.native.dispose();
    } catch (cleanupError) {
      throw new ResponseCleanupError(cleanupError);
    }

    return result as never;
  }
}

function asBuffer(data: BinaryInput) {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  const bytes = asBytes(data);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function playwrightMultipart(
  fields: RequestKindMap["multipart"],
): NonNullable<PlaywrightFetchOptions["multipart"]> {
  if (fields instanceof FormData) {
    return fields;
  }

  if (Array.isArray(fields)) {
    return asFormData(fields);
  }

  const result: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> =
    Object.create(null);
  const record = fields as Exclude<typeof fields, readonly unknown[]>;

  for (const name in record) {
    const value = record[name];
    if (value === undefined) {
      continue;
    }

    if (isMultipartFile(value)) {
      if (value.filename === "" || value.mediaType === "") {
        return asFormData(fields);
      }

      result[name] = {
        name: value.filename ?? defaultFilename,
        mimeType: value.mediaType ?? defaultFileMediaType,
        buffer: asBuffer(value.data),
      };
    } else if (Array.isArray(value)) {
      return asFormData(fields);
    } else {
      result[name] = value === null ? "" : String(value);
    }
  }

  return result;
}

/**
 * Playwright resolves a relative URL against `use.baseURL`. A `/` at the
 * start replaces the path of that URL, so `./` keeps it.
 */
function underUseBaseUrl(request: { readonly url: string; readonly reference: Reference }) {
  return request.reference === "path" && request.url[0] === "/"
    ? "." + request.url
    : request.url;
}

/** The transport that {@link playwrightTransport} returns. */
export type PlaywrightTransport = Transport<
  RequestKindMap,
  ResponseKindMap,
  PlaywrightNativeOptions,
  PlaywrightMetadata
>;

/**
 * Send requests with Playwright and dispose each response after use.
 *
 * @remarks
 * Use Playwright 1.62 or later. Do not set `content-type: null` on a
 * request with a body.
 *
 * @example
 * ```ts
 * import { c } from "@dlenroc/typed-client";
 * import { playwrightTransport } from "@dlenroc/typed-client/playwright";
 * import { request } from "playwright-core";
 *
 * const context = await request.newContext();
 * try {
 *   const transport = playwrightTransport({
 *     context,
 *     baseUrl: "https://api.example.test",
 *   });
 *   const health = c.bind(c.endpoint("/health"), transport);
 *   await health({ status: 204, timeout: 5000 });
 * } finally {
 *   await context.dispose();
 * }
 * ```
 *
 * @see {@link https://playwright.dev/docs/api-testing | API testing}
 */
export function playwrightTransport(config: {
  /**
   * The `request` fixture or a context from `request.newContext()`.
   * Dispose contexts you create.
   */
  readonly context: PlaywrightContext;

  /**
   * Relative endpoints append to this URL's path. Without it, Playwright
   * resolves them under `use.baseURL`.
   */
  readonly baseUrl?: string | undefined;
}): PlaywrightTransport {
  const resolveUrl =
    config.baseUrl === undefined ? underUseBaseUrl : createUrlResolver(config.baseUrl);

  return async (request) => {
    const url = resolveUrl(request);
    let prepared = false;

    try {
      // The request sets the headers, the body, and the URL; the options
      // never do.
      const {
        headers: _headers,
        data: _data,
        form: _form,
        multipart: _multipart,
        params: _params,
        ...native
      } = (request.options ?? {}) as PlaywrightFetchOptions;

      const options: PlaywrightFetchOptions = {
        ...native,
        method: request.method,
        failOnStatusCode: false,
      };

      const body = request.body;
      if (body !== undefined) {
        // Playwright parses or JSON-encodes some string bodies, so send bytes.
        switch (request.bodyKind) {
          case "none":
            throw new TypeError("Request body kind none does not allow a body");

          case "json":
            options.data = Buffer.from(encodeJson(body));
            break;

          case "text":
            options.data = Buffer.from(body as string);
            break;

          case "binary":
            options.data = asBuffer(body as BinaryInput);
            break;

          case "urlencoded":
            options.data = Buffer.from(encodeFields(body as RequestKindMap["urlencoded"]));
            break;

          case "multipart":
            options.multipart = playwrightMultipart(body as RequestKindMap["multipart"]);
            break;

          default:
            throw new TypeError(`Unsupported request body kind: ${String(request.bodyKind)}`);
        }
      }

      if (request.headers !== undefined || body !== undefined) {
        const selected = prepareHeaders(request.headers, request.bodyKind, body !== undefined);

        if (selected.contentTypeSuppressed && body !== undefined) {
          throw new TypeError("Playwright cannot suppress Content-Type for a request with a body");
        }

        options.headers = selected.fields;
      }

      if (options.maxRedirects === undefined && !request.follow) {
        options.maxRedirects = 0;
      }

      if (request.timeout !== undefined) {
        options.timeout = request.timeout;
      }

      prepared = true;
      return await PlaywrightResponseHandle.create(await config.context.fetch(url, options));
    } catch (failure) {
      throw new AdapterFailure(prepared ? "transport" : "request", url, failure);
    }
  };
}
