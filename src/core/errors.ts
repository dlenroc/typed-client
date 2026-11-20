import type { ResponseHeaders, StandardIssue } from "./types.js";

type Meta = Readonly<Record<string, unknown>>;

type SchemaPart = "path" | "query" | "headers" | "body";

/**
 * The error that a bound call throws. Narrow by `code` to read its fields.
 *
 * @remarks
 * - `request`: Nothing was sent because the call input, URL, preparation,
 *   or a schema failed.
 * - `transport`: The transport failed to deliver or release a response.
 * - `timeout`: The transport failed with an error named `TimeoutError`.
 * - `status`: The status falls outside the accepted set.
 * - `response`: The body cannot be decoded, or a response schema rejects
 *   the response.
 *
 * `schema` names the schema that failed. It reported `issues` or threw
 * `cause`. `status` and `response` errors keep the raw response `headers`
 * and the `body` that the client read.
 *
 * @example
 * ```ts
 * if (error instanceof ClientError && error.code === "status") {
 *   console.log(error.meta.operationId, error.status);
 * }
 * ```
 */
export type ClientError = Error & {
  readonly method: string;

  /** Resolved request or response URL, when available. */
  readonly url: string | undefined;

  /** The endpoint's metadata object, passed by reference. */
  readonly meta: Meta;

  readonly cause: unknown;

  /** Present only when cleanup failed as well as the primary failure. */
  cleanupError?: unknown;
} & (
    | {
        /**
         * Nothing was sent because the call input, URL, preparation, or a
         * schema failed.
         */
        readonly code: "request";
        readonly status: undefined;
        readonly schema: SchemaPart | undefined;
        readonly issues: readonly StandardIssue[] | undefined;
        readonly headers: undefined;
        readonly body: undefined;
      }
    | {
        /** The transport failed to deliver or release a response. */
        readonly code: "transport";

        /** Set when a response arrived but could not be released. */
        readonly status: number | undefined;
        readonly schema: undefined;
        readonly issues: undefined;
        readonly headers: undefined;
        readonly body: undefined;
      }
    | {
        /** The transport failed with an error named `TimeoutError`. */
        readonly code: "timeout";
        readonly status: number | undefined;
        readonly schema: undefined;
        readonly issues: undefined;
        readonly headers: undefined;
        readonly body: undefined;
      }
    | {
        /** The status falls outside the accepted set. */
        readonly code: "status";
        readonly status: number;
        readonly schema: undefined;
        readonly issues: undefined;
        readonly headers: ResponseHeaders;

        /**
         * The body as text if the `Content-Type` is textual or absent.
         * `undefined` for other types or if the body cannot be read.
         */
        readonly body: string | undefined;
      }
    | {
        /**
         * The body cannot be decoded, or a response schema rejects the
         * response.
         */
        readonly code: "response";
        readonly status: number;

        /** `undefined` when the body could not be decoded. */
        readonly schema: "headers" | "body" | undefined;
        readonly issues: readonly StandardIssue[] | undefined;
        readonly headers: ResponseHeaders;

        /**
         * The decoded value that the body schema rejected. `undefined` if
         * the body could not be decoded or the headers schema failed.
         */
        readonly body: unknown;
      }
  );

// URL credentials are secrets, and messages go to logs.
function withoutCredentials(url: string) {
  return url.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/?#]*@/i, "$1");
}

function pathText(path: StandardIssue["path"] = []) {
  let text = "";

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    const key = typeof segment === "object" ? segment.key : segment;
    text += typeof key === "number" ? `[${key}]` : (i === 0 ? "" : ".") + String(key);
  }

  return text;
}

function issueText(issue: StandardIssue) {
  const path = pathText(issue.path);

  // Some schemas, such as ArkType, start the message with the path.
  if (path === "" || issue.message.startsWith(`${path} `)) {
    return issue.message;
  }

  return issue.message === "" ? path : `${path}: ${issue.message}`;
}

function issuesText(issues: readonly StandardIssue[]) {
  const shown = Math.min(issues.length, 10);
  let text = "";

  for (let i = 0; i < shown; i++) {
    text += `\n  - ${issueText(issues[i]!)}`;
  }

  if (issues.length > shown) {
    text += `\n  - … ${issues.length - shown} more`;
  }

  return text;
}

// Only the first line: native messages can add call logs with headers.
function firstLine(error: unknown) {
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const line = text.split("\n", 1)[0]!;

  // Node gives a refused connection to `localhost` only as a code.
  const code = (error as { code?: unknown } | undefined)?.code;
  return line === "" && typeof code === "string" ? code : line;
}

function causeText(cause: unknown) {
  const outer = firstLine(cause);
  if (outer === "") {
    return "";
  }

  const inner = firstLine((cause as Error).cause);
  return inner === "" ? `: ${outer}` : `: ${outer} (${inner})`;
}

/** The most characters of a response body that a message shows. */
const bodyLimit = 1000;

function bodyText(text: string | undefined) {
  if (text === undefined || text === "") {
    return "";
  }

  return "\n" + (text.length > bodyLimit ? text.slice(0, bodyLimit) + "…" : text);
}

function describe(
  summary: string,
  method: string,
  url: string | undefined,
  issues: readonly StandardIssue[] | undefined,
  cause: unknown,
  text: string | undefined,
) {
  const detail =
    (issues !== undefined && issues.length > 0 ? issuesText(issues) : causeText(cause)) +
    bodyText(text);

  if (!url) {
    return summary + detail;
  }

  // The detail can repeat the request URL.
  const requestUrl = withoutCredentials(url);
  return `${summary} for ${method} ${requestUrl}${detail.replaceAll(url, () => requestUrl)}`;
}

/** @internal */
export interface ClientErrorFields {
  readonly code: ClientError["code"];
  readonly summary: string;
  readonly method: string;
  readonly url?: string | undefined;
  readonly template?: string | undefined;
  readonly meta: Meta;
  readonly status?: number | undefined;
  readonly schema?: SchemaPart | undefined;
  readonly issues?: readonly StandardIssue[] | undefined;
  readonly headers?: ResponseHeaders | undefined;
  readonly body?: unknown;
  readonly cause?: unknown;
}

class ClientErrorInstance extends Error {
  declare readonly code: string;
  declare readonly method: string;
  declare readonly url: string | undefined;
  declare readonly meta: Meta;
  declare readonly status: number | undefined;
  declare readonly schema: string | undefined;
  declare readonly issues: readonly StandardIssue[] | undefined;
  declare readonly headers: ResponseHeaders | undefined;
  declare readonly body: unknown;
  declare cleanupError?: unknown;

  constructor(fields: ClientErrorFields) {
    super(
      describe(
        fields.summary,
        fields.method,
        fields.url ?? fields.template,
        fields.issues,
        fields.cause,
        // Only a status error shows its body: a schema error lists issues.
        fields.code === "status" ? (fields.body as string | undefined) : undefined,
      ),
    );

    this.code = fields.code;
    this.method = fields.method;
    this.url = fields.url;
    this.meta = fields.meta;
    this.status = fields.status;
    this.schema = fields.schema;
    this.issues = fields.issues;
    this.headers = fields.headers;
    this.body = fields.body;
    this.cause = fields.cause;
  }
}

Object.defineProperty(ClientErrorInstance, "name", { value: "ClientError" });
ClientErrorInstance.prototype.name = "ClientError";

export const ClientError = ClientErrorInstance as unknown as {
  /** @internal */
  new (fields: ClientErrorFields): ClientError;
};

export class ResponseCleanupError extends Error {
  constructor(cause: unknown) {
    super("Failed to release transport response resources", { cause });
    this.name = "ResponseCleanupError";
  }
}

export class FailureWithCleanupError extends Error {
  constructor(
    cause: unknown,
    readonly cleanupError: unknown,
  ) {
    super("Operation and response cleanup failed", { cause });
    this.name = "FailureWithCleanupError";
  }
}

export function preserveCleanupError(error: ClientError, failure: unknown) {
  if (
    failure !== null &&
    (typeof failure === "object" || typeof failure === "function") &&
    "cleanupError" in failure
  ) {
    error.cleanupError = failure.cleanupError;
  }

  return error;
}

/** @internal The transport failure without the cleanup wrapper. */
export function failureCause(failure: unknown): unknown {
  return failure instanceof FailureWithCleanupError ? failure.cause : failure;
}

export function isTimeoutError(cause: unknown): boolean {
  return (cause as { name?: unknown } | null)?.name === "TimeoutError";
}

// Only the adapter knows the resolved URL and whether sending had begun.
export class AdapterFailure extends Error {
  constructor(
    readonly stage: "request" | "transport",
    readonly url: string,
    cause: unknown,
  ) {
    super(stage === "request" ? "Cannot prepare request" : "Cannot get response", { cause });
  }
}

export function transportError(
  request: {
    readonly method: string;
    readonly url: string;
    readonly endpoint: { readonly meta: Meta };
  },
  failure: unknown,
): ClientError {
  const adapter = failure instanceof AdapterFailure ? failure : undefined;
  const original = adapter ? adapter.cause : failure;
  const cause = failureCause(original);

  let code: ClientError["code"] = adapter?.stage ?? "transport";
  let summary = adapter?.message ?? "Cannot get response";
  if (code === "transport" && isTimeoutError(cause)) {
    code = "timeout";
    summary = "Timed out waiting for response";
  }

  return preserveCleanupError(
    new ClientError({
      code,
      summary,
      method: request.method,
      url: adapter?.url ?? request.url,
      meta: request.endpoint.meta,
      cause,
    }),
    original,
  );
}

/** A request or response schema reported issues or threw `cause`. */
export function schemaError(
  method: string,
  url: string | undefined,
  template: string,
  meta: Meta,
  status: number | undefined,
  schema: SchemaPart,
  issues: readonly StandardIssue[] | undefined,
  cause: unknown,
  headers?: ResponseHeaders,
  body?: unknown,
): ClientError {
  const outcome =
    issues === undefined
      ? "threw"
      : `reported ${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  return new ClientError({
    code: status === undefined ? "request" : "response",
    summary:
      status === undefined
        ? `Request ${schema} schema ${outcome}`
        : `Response ${schema} schema ${outcome} (status ${status})`,
    method,
    url,
    template,
    meta,
    status,
    schema,
    issues,
    headers,
    body,
    cause,
  });
}
