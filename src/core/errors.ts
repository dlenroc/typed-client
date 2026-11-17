import type { StandardIssue } from "./types.js";

type Meta = Readonly<Record<string, unknown>>;

type SchemaPart = "path" | "query" | "headers" | "body";

/**
 * The error that a bound call throws. Narrow by `code` to read its fields.
 *
 * @remarks
 * - `request`: Nothing was sent because the call input, URL, preparation,
 *   or a schema failed.
 * - `transport`: The transport failed to deliver or release a response.
 * - `status`: The status falls outside the accepted set.
 * - `response`: The body cannot be decoded, or a response schema rejects
 *   the response.
 *
 * `schema` names the schema that failed. It reported `issues` or threw
 * `cause`.
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
      }
    | {
        /** The transport failed to deliver or release a response. */
        readonly code: "transport";

        /** Set when a response arrived but could not be released. */
        readonly status: number | undefined;
        readonly schema: undefined;
        readonly issues: undefined;
      }
    | {
        /** The status falls outside the accepted set. */
        readonly code: "status";
        readonly status: number;
        readonly schema: undefined;
        readonly issues: undefined;
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

const shownIssues = 10;

function issuesText(issues: readonly StandardIssue[]) {
  const shown = Math.min(issues.length, shownIssues);
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
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
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

function describe(
  summary: string,
  method: string,
  url: string | undefined,
  issues: readonly StandardIssue[] | undefined,
  cause: unknown,
) {
  const detail =
    issues !== undefined && issues.length > 0 ? issuesText(issues) : causeText(cause);
  if (!url) {
    return summary + detail;
  }

  const requestUrl = withoutCredentials(url);
  // The detail can repeat the request URL.
  return `${summary} for ${method} ${requestUrl}${detail.replaceAll(url, () => requestUrl)}`;
}

class ClientErrorInstance extends Error {
  declare readonly code: string;
  declare readonly method: string;
  declare readonly url: string | undefined;
  declare readonly meta: Meta;
  declare readonly status: number | undefined;
  declare readonly schema: string | undefined;
  declare readonly issues: readonly StandardIssue[] | undefined;
  declare cleanupError?: unknown;

  constructor(
    code: ClientError["code"],
    summary: string,
    method: string,
    url: string | undefined,
    meta: Meta,
    status: number | undefined,
    schema: SchemaPart | undefined,
    issues: readonly StandardIssue[] | undefined,
    cause: unknown,
  ) {
    super(describe(summary, method, url, issues, cause));
    this.code = code;
    this.method = method;
    this.url = url;
    this.meta = meta;
    this.status = status;
    this.schema = schema;
    this.issues = issues;
    this.cause = cause;
  }
}

Object.defineProperty(ClientErrorInstance, "name", { value: "ClientError" });
ClientErrorInstance.prototype.name = "ClientError";

export const ClientError = ClientErrorInstance as unknown as {
  /** @internal */
  new (...args: ConstructorParameters<typeof ClientErrorInstance>): ClientError;
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

export function transportError(
  prepared: boolean,
  method: string,
  url: string,
  meta: Meta,
  failure: unknown,
): ClientError {
  return preserveCleanupError(
    new ClientError(
      prepared ? "transport" : "request",
      prepared ? "Cannot get response" : "Cannot prepare request",
      method,
      url,
      meta,
      undefined,
      undefined,
      undefined,
      failure instanceof FailureWithCleanupError ? failure.cause : failure,
    ),
    failure,
  );
}
