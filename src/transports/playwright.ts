import { Buffer } from "node:buffer";
import type { APIRequestContext, APIResponse } from "playwright-core";
import type {
  BinaryInput,
  RequestKindMap,
  ResponseKindMap,
  ResponseHeaders,
  Transport,
  TransportResponse,
} from "../core/types.js";
import { encodeFields } from "../shared/fields.js";
import {
  ResponseCleanupError,
  FailureWithCleanupError,
  transportError,
} from "../core/errors.js";
import { asFormData, encodeJson } from "./body.js";
import { prepareHeaders, appendResponseHeader } from "./headers.js";
import { createUrlResolver } from "../shared/url.js";
import { decodeUrlEncoded, decodeMultipart } from "./codec.js";

interface PlaywrightMetadata {
  readonly statusText: string;
}

type PlaywrightContext = Pick<APIRequestContext, "fetch">;
type PlaywrightFetchOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;
const NATIVE_OPTION_KEYS = [
  "timeout",
  "maxRedirects",
  "maxRetries",
  "ignoreHTTPSErrors",
  "signal",
] as const;

type PlaywrightNativeOptions = Pick<PlaywrightFetchOptions, (typeof NATIVE_OPTION_KEYS)[number]>;

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
  readonly headers: ResponseHeaders;
  readonly transport: PlaywrightMetadata;
  private consumed = false;

  private constructor(
    private readonly native: APIResponse,
    headers: ResponseHeaders,
  ) {
    this.headers = headers;
    this.status = native.status();
    this.url = native.url();
    this.transport = { statusText: native.statusText() };
  }

  static async create(native: APIResponse) {
    try {
      const headers: Record<string, string | string[]> = Object.create(null);
      const entries = native.headersArray();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        appendResponseHeader(headers, entry.name, entry.value);
      }

      return new PlaywrightResponseHandle(native, headers);
    } catch (cause) {
      return disposeAfterFailure(native, cause);
    }
  }

  async read<Kind extends keyof ResponseKindMap>(kind: Kind): Promise<ResponseKindMap[Kind]> {
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
        const bytes = await this.native.body();
        result = decodeMultipart(bytes, this.headers["content-type"]);
      } else {
        throw new TypeError(`Unsupported Playwright response kind: ${String(kind)}`);
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

  return data instanceof ArrayBuffer
    ? Buffer.from(data)
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
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

  const result: Record<
    string,
    string | { name: string; mimeType: string; buffer: Buffer }
  > = Object.create(null);

  const record = fields as Exclude<typeof fields, readonly unknown[]>;
  for (const name in record) {
    const value = record[name];
    if (value === undefined) {
      continue;
    }

    if (value !== null && typeof value === "object" && "data" in value) {
      if (value.filename === "" || value.mediaType === "") {
        return asFormData(fields);
      }

      result[name] = {
        name: value.filename ?? "blob",
        mimeType: value.mediaType ?? "application/octet-stream",
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
 * Disposes each response after reading or discarding it.
 *
 * @remarks
 * Use Playwright 1.62 or later. Pass the test's `request` fixture or
 * create one with `request.newContext()`. Keep Content-Type enabled
 * when sending a body.
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
  /** Dispose contexts you create. */
  readonly context: PlaywrightContext;

  /** Relative endpoints append to this URL's path. */
  readonly baseUrl?: string;
}): Transport<RequestKindMap, ResponseKindMap, PlaywrightNativeOptions, PlaywrightMetadata> {
  const resolveUrl = createUrlResolver(config.baseUrl);

  return async (request) => {
    const url = resolveUrl(request.url);
    let prepared = false;

    try {
      const options: PlaywrightFetchOptions = {
        method: request.method,
        failOnStatusCode: false,
      };

      const body = request.body;
      if (body !== undefined) {
        switch (request.bodyKind) {
          case "none":
            throw new TypeError("none request body kind cannot have a body");

          case "json":
            options.data = encodeJson(body);
            break;

          case "text":
            options.data = body as string;
            break;

          case "binary":
            options.data = asBuffer(body as BinaryInput);
            break;

          case "urlencoded":
            options.data = encodeFields(body as RequestKindMap["urlencoded"]);
            break;

          case "multipart":
            options.multipart = playwrightMultipart(body as RequestKindMap["multipart"]);
            break;

          default:
            throw new TypeError(`Unsupported Playwright body kind: ${String(request.bodyKind)}`);
        }
      }

      if (request.headers !== undefined || request.body !== undefined) {
        let suppressContentType = false;
        const preparedHeaders = prepareHeaders(
          request.headers,
          request.bodyKind,
          request.body !== undefined,
          (suppressed) => {
            suppressContentType = suppressed;
          },
        );

        if (suppressContentType && request.body !== undefined) {
          throw new TypeError("Playwright cannot suppress Content-Type for a request with a body");
        }

        if (options.multipart !== undefined && request.input?.unchecked !== true) {
          delete preparedHeaders["content-type"];
        }

        const contentType = preparedHeaders["content-type"];
        if (
          request.bodyKind !== "json" &&
          typeof options.data === "string" &&
          typeof contentType === "string" &&
          contentType.split(";", 1)[0]!.trim().toLowerCase() === "application/json"
        ) {
          // Bytes prevent Playwright from JSON-encoding raw strings.
          options.data = Buffer.from(options.data);
        }

        options.headers = preparedHeaders;
      }

      for (let i = 0; i < NATIVE_OPTION_KEYS.length; i++) {
        const key = NATIVE_OPTION_KEYS[i]!;
        const value = request.input?.[key];
        if (value !== undefined) {
          options[key] = value as never;
        }
      }

      prepared = true;
      const response = await config.context.fetch(url, options);
      return await PlaywrightResponseHandle.create(response);
    } catch (failure) {
      throw transportError(prepared, request.method, url, request.meta, failure);
    }
  };
}
