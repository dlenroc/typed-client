import type { StandardIssue } from "./types.js";

type Meta = Readonly<Record<string, unknown>>;

type SchemaPart = "path" | "query" | "headers" | "body";

/**
 * Narrow by `code` to read failure-specific fields.
 *
 * @remarks
 * `request` means nothing was sent: the call input, URL, body
 * preparation, or a request schema failed. `transport` means the adapter
 * failed to deliver or release a response. `status` means the status
 * fell outside the accepted set. `response` means the response broke
 * the contract: its body could not be decoded or a schema rejected it.
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

  /** The underlying failure, when there is one. */
  readonly cause: unknown;

  /** Present only when cleanup failed as well as the primary failure. */
  cleanupError?: unknown;
} & (
    | {
        readonly code: "request";
        readonly status: undefined;
        readonly schema: SchemaPart | undefined;
        readonly issues: readonly StandardIssue[] | undefined;
      }
    | {
        readonly code: "transport";

        /** Set when a response arrived but could not be released. */
        readonly status: number | undefined;
        readonly schema: undefined;
        readonly issues: undefined;
      }
    | {
        readonly code: "status";
        readonly status: number;
        readonly schema: undefined;
        readonly issues: undefined;
      }
    | {
        readonly code: "response";
        readonly status: number;

        /** `undefined` when the body could not be decoded. */
        readonly schema: "headers" | "body" | undefined;
        readonly issues: readonly StandardIssue[] | undefined;
      }
  );

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
    message: string,
    method: string,
    url: string | undefined,
    meta: Meta,
    status: number | undefined,
    schema: SchemaPart | undefined,
    issues: readonly StandardIssue[] | undefined,
    cause: unknown,
  ) {
    super(message);
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
      prepared ? "Transport failed to return a response" : "Request preparation failed",
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
