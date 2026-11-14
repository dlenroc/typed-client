import type { ResponseHeaders, StandardIssue } from "./types.js";

export interface ErrorContext {
  readonly method: string;
  readonly url?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

type SchemaFailure =
  | { readonly reason: "issues"; readonly issues: readonly StandardIssue[] }
  | { readonly reason: "exception" };

type ResponseDiagnostics = {
  readonly status: number;
  readonly headers: ResponseHeaders;
};

/**
 * `request-input` covers an empty status list. `request-url` and
 * `request-prepare` cover URL construction and request preparation.
 * `transport` means the adapter failed to return a response.
 *
 * Schema failures identify the `field` and whether validation reported
 * `issues` or threw an exception. Response failures include the status
 * and raw headers. `status` adds the accepted statuses, `response-decode`
 * adds the body kind, and `response-cleanup` means only cleanup failed.
 */
type Failure =
  | { readonly code: "request-input" }
  | { readonly code: "request-url" }
  | { readonly code: "request-prepare" }
  | ({
      readonly code: "request-schema";
      readonly field: "path" | "query" | "headers" | "body";
    } & SchemaFailure)
  | { readonly code: "transport" }
  | (ResponseDiagnostics &
      (
        | { readonly code: "status"; readonly expectedStatuses: readonly number[] }
        | { readonly code: "response-decode"; readonly kind: string }
        | ({ readonly code: "response-schema"; readonly field: "headers" | "body" } & SchemaFailure)
        | { readonly code: "response-cleanup" }
      ));

function errorMessage(failure: Failure) {
  switch (failure.code) {
    case "request-input":
      return "Invalid call input";

    case "request-url":
      return "Request URL construction failed";

    case "request-prepare":
      return "Request preparation failed";

    case "transport":
      return "Transport failed to return a response";

    case "response-cleanup":
      return `Response cleanup failed (status ${failure.status})`;

    case "status":
      return `Unexpected status ${failure.status}; expected ${failure.expectedStatuses.join(", ")}`;

    case "response-decode":
      return `Cannot decode ${failure.kind} response (status ${failure.status})`;

    case "request-schema":
    case "response-schema": {
      const origin = failure.code === "request-schema" ? "Request" : "Response";
      const reason =
        failure.reason === "issues"
          ? `reported ${failure.issues.length} issue${failure.issues.length === 1 ? "" : "s"}`
          : "threw";
      const status = failure.code === "response-schema" ? ` (status ${failure.status})` : "";

      return `${origin} ${failure.field} schema ${reason}${status}`;
    }
  }
}

export type ClientError = Error & {
  readonly method: string;

  /** Resolved request or response URL, when available. */
  readonly url: string | undefined;

  /** Shares the endpoint metadata object and defaults to an empty object. */
  readonly meta: Readonly<Record<string, unknown>>;

  /** Cleanup failure retained without replacing the primary error. */
  cleanupError?: unknown;
} & Failure;

type ClientErrorOptions = ErrorContext & Failure & { readonly cause?: unknown };

class ClientErrorInstance extends Error {
  declare readonly method: string;
  readonly url: string | undefined;
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(options: ClientErrorOptions) {
    super(
      errorMessage(options),
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    Object.assign(this, options);
    this.name = "ClientError";
    this.url = options.url;
    this.meta = options.meta ?? {};
  }
}

/**
 * Narrow by `code` to read failure-specific fields.
 *
 * @remarks
 * `cause` holds the underlying failure and `cleanupError` holds a
 * secondary cleanup failure. Diagnostic fields such as `code` and
 * `meta` are enumerable. Read `message` and `cause` explicitly for JSON.
 *
 * @example
 * ```ts
 * if (error instanceof ClientError && error.code === "status") {
 *   console.log(error.status, error.expectedStatuses);
 * }
 * ```
 *
 * @example
 * ```ts
 * throw new ClientError({
 *   code: "transport", method: "GET", cause,
 * });
 * ```
 */
export const ClientError = ClientErrorInstance as unknown as {
  new (options: ClientErrorOptions): ClientError;
};

export class RequestPreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestPreparationError";
  }
}

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

export class TransportFailure extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super("Transport request failed", { cause });
  }
}
