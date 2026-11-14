import { appendQuery } from "../shared/url.js";
import type { BoundContract, Endpoint, EndpointTree, ValidateBinding } from "./contract-types.js";
import { renderPath } from "./endpoint.js";
import {
  ClientError,
  FailureWithCleanupError,
  RequestPreparationError,
  ResponseCleanupError,
  TransportFailure,
  type ErrorContext,
} from "./errors.js";
import type {
  AnyTransport,
  HeaderInput,
  QueryInput,
  StandardIssue,
  StandardSchemaV1,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./types.js";

const ONLY_NONE = ["none"] as const;

function schemaError(
  origin: "request" | "response",
  field: "path" | "query" | "headers" | "body",
  context: ErrorContext,
  failure: { readonly issues: readonly StandardIssue[] } | { readonly cause: unknown },
  response?: { status: number; headers: TransportResponse["headers"] },
): ClientError {
  const details =
    "issues" in failure
      ? { reason: "issues" as const, issues: failure.issues }
      : { reason: "exception" as const, cause: failure.cause };

  return new ClientError(
    origin === "request"
      ? { ...context, ...details, code: "request-schema", field }
      : {
          ...context,
          ...details,
          code: "response-schema",
          field: field as "headers" | "body",
          status: response!.status,
          headers: response!.headers,
        },
  );
}

function selectResponseKinds(
  endpoint: Endpoint,
  expectation: number | readonly number[] | undefined,
  discard: boolean,
): readonly string[] {
  if (discard) {
    return ONLY_NONE;
  }

  if (expectation === undefined) {
    return endpoint.responseKinds;
  }

  if (typeof expectation === "number") {
    return endpoint.responses[expectation]?.responseKinds ?? ONLY_NONE;
  }

  if (expectation.length === 1) {
    return endpoint.responses[expectation[0]!]?.responseKinds ?? ONLY_NONE;
  }

  const kinds = new Set<string>();

  for (const status of expectation) {
    kinds.add(endpoint.responses[status]?.kind ?? "none");
  }

  return [...kinds];
}

async function rejectResponse(
  handle: TransportResponse<any, any>,
  primary: ClientError,
  bodyWasRead = false,
): Promise<never> {
  try {
    if (handle.discard) {
      await handle.discard();
    } else if (!bodyWasRead) {
      await handle.read("none");
    }
  } catch (cleanupError) {
    primary.cleanupError = cleanupError;
  }

  throw primary;
}

function preserveCleanupError(error: ClientError, failure: unknown) {
  if (
    failure !== null &&
    (typeof failure === "object" || typeof failure === "function") &&
    "cleanupError" in failure
  ) {
    error.cleanupError = failure.cleanupError;
  }

  return error;
}

async function invoke(
  endpoint: Endpoint,
  transport: Transport<any, any, any, any>,
  input?: Record<string, unknown>,
): Promise<unknown> {
  const unchecked = input?.unchecked === true;
  const discard = input?.discard === true;
  const expectedStatus = input?.status as number | readonly number[] | undefined;
  const method = unchecked
    ? ((input?.method as string | undefined) ?? endpoint.method)
    : endpoint.method;
  const context: { method: string; url?: string; meta: Endpoint["meta"] } = {
    method,
    meta: endpoint.meta,
  };

  if (Array.isArray(expectedStatus) && expectedStatus.length === 0) {
    throw new ClientError({
      ...context,
      code: "request-input",
      cause: new TypeError("status must not be empty"),
    });
  }

  let path = input?.path;
  let query = input?.query;
  let headers = input?.headers;
  let body = input?.body;

  if (!unchecked) {
    if (endpoint.pathSchema !== undefined) {
      let result;
      try {
        result = (endpoint.pathSchema as StandardSchemaV1)["~standard"].validate(path);
        if ("then" in result) {
          result = await result;
        }
      } catch (cause) {
        throw schemaError("request", "path", context, { cause });
      }

      if (result.issues) {
        throw schemaError("request", "path", context, { issues: result.issues });
      }

      path = result.value;
    }

    if (endpoint.querySchema !== undefined) {
      let result;
      try {
        result = (endpoint.querySchema as StandardSchemaV1)["~standard"].validate(query);
        if ("then" in result) {
          result = await result;
        }
      } catch (cause) {
        throw schemaError("request", "query", context, { cause });
      }

      if (result.issues) {
        throw schemaError("request", "query", context, { issues: result.issues });
      }

      query = result.value;
    }

    if (endpoint.headersSchema !== undefined) {
      let result;
      try {
        result = (endpoint.headersSchema as StandardSchemaV1)["~standard"].validate(headers);
        if ("then" in result) {
          result = await result;
        }
      } catch (cause) {
        throw schemaError("request", "headers", context, { cause });
      }

      if (result.issues) {
        throw schemaError("request", "headers", context, { issues: result.issues });
      }

      headers = result.value;
    }

    if (endpoint.body.schema !== undefined) {
      let result;
      try {
        result = (endpoint.body.schema as StandardSchemaV1)["~standard"].validate(body);
        if ("then" in result) {
          result = await result;
        }
      } catch (cause) {
        throw schemaError("request", "body", context, { cause });
      }

      if (result.issues) {
        throw schemaError("request", "body", context, { issues: result.issues });
      }

      body = result.value;
    }
  }

  let url: string;
  try {
    url = appendQuery(
      unchecked && typeof path === "string" ? path : renderPath(endpoint.path, path),
      query as QueryInput | undefined,
    );
  } catch (cause) {
    throw new ClientError({ ...context, code: "request-url", cause });
  }

  const bodyKind = unchecked ? (input?.bodyKind ?? endpoint.body.kind) : endpoint.body.kind;
  const responseKinds = selectResponseKinds(endpoint, expectedStatus, discard);
  const transportRequest: TransportRequest = {
    method,
    url,
    headers: headers as HeaderInput | undefined,
    bodyKind: bodyKind as TransportRequest["bodyKind"],
    body: body as TransportRequest["body"],
    responseKinds: responseKinds as TransportRequest["responseKinds"],
    meta: endpoint.meta,
    input,
  };

  let handle: TransportResponse<any, any>;
  try {
    handle = await transport(transportRequest);
  } catch (failure) {
    context.url = failure instanceof TransportFailure ? failure.url : transportRequest.url;

    const attempt = failure instanceof TransportFailure ? failure.cause : failure;
    const cause = attempt instanceof FailureWithCleanupError ? attempt.cause : attempt;
    const wrapped =
      cause instanceof RequestPreparationError
        ? new ClientError({ ...context, code: "request-prepare", cause })
        : new ClientError({ ...context, code: "transport", cause });

    throw preserveCleanupError(wrapped, attempt);
  }

  context.url = handle.url;
  const status = handle.status;
  const responseSpec = endpoint.responses[status];
  const accepted =
    expectedStatus === undefined
      ? responseSpec !== undefined
      : typeof expectedStatus === "number"
        ? status === expectedStatus
        : expectedStatus.includes(status);

  if (!accepted) {
    const expectedStatuses =
      expectedStatus === undefined
        ? Object.keys(endpoint.responses).map(Number)
        : typeof expectedStatus === "number"
          ? [expectedStatus]
          : expectedStatus;

    return rejectResponse(
      handle,
      new ClientError({
        ...context,
        code: "status",
        status,
        expectedStatuses,
        headers: handle.headers,
      }),
    );
  }

  let responseHeaders: unknown = handle.headers;

  if (responseSpec?.headersSchema) {
    let result;
    try {
      result = (responseSpec.headersSchema as StandardSchemaV1)["~standard"].validate(
        responseHeaders,
      );
      if ("then" in result) {
        result = await result;
      }
    } catch (cause) {
      return rejectResponse(handle, schemaError("response", "headers", context, { cause }, handle));
    }

    if (result.issues) {
      return rejectResponse(
        handle,
        schemaError("response", "headers", context, { issues: result.issues }, handle),
      );
    }

    responseHeaders = result.value;
  }

  const kind = discard || responseSpec === undefined ? "none" : responseSpec.kind;
  let responseBody: unknown;

  try {
    responseBody = await handle.read(kind);
  } catch (failure) {
    const cause = failure instanceof FailureWithCleanupError ? failure.cause : failure;
    const cleanupFailed = cause instanceof ResponseCleanupError;
    const diagnostics = { ...context, status, headers: handle.headers };
    const wrapped =
      kind === "none" || cleanupFailed
        ? new ClientError({
            ...diagnostics,
            code: "response-cleanup",
            cause: cleanupFailed ? cause.cause : cause,
          })
        : new ClientError({ ...diagnostics, code: "response-decode", kind, cause });

    throw preserveCleanupError(wrapped, failure);
  }

  if (!discard && responseSpec?.bodySchema !== undefined) {
    let result;
    try {
      result = (responseSpec.bodySchema as StandardSchemaV1)["~standard"].validate(responseBody);
      if ("then" in result) {
        result = await result;
      }
    } catch (cause) {
      return rejectResponse(
        handle,
        schemaError("response", "body", context, { cause }, handle),
        true,
      );
    }

    if (result.issues) {
      return rejectResponse(
        handle,
        schemaError("response", "body", context, { issues: result.issues }, handle),
        true,
      );
    }

    responseBody = result.value;
  }

  if (handle.transport === undefined) {
    return { status, url: handle.url, headers: responseHeaders, body: responseBody };
  }

  return {
    status,
    url: handle.url,
    headers: responseHeaders,
    body: responseBody,
    transport: handle.transport,
  };
}

export function bind<const Contract extends EndpointTree, Adapter extends AnyTransport>(
  contract: Contract & ValidateBinding<Contract, Adapter>,
  transport: Adapter,
): BoundContract<Contract, Adapter> {
  const adapter = transport as Transport<any, any, any, any>;

  function visit(node: unknown): unknown {
    const endpoint = node as Endpoint;
    if (typeof endpoint?.method === "string") {
      return (input?: Record<string, unknown>) => invoke(endpoint, adapter, input);
    }

    const group: Record<string, unknown> = {};
    const entries = node as Record<string, unknown>;

    for (const key of Object.keys(entries)) {
      group[key] = visit(entries[key]);
    }

    return group;
  }

  return visit(contract) as BoundContract<Contract, Adapter>;
}
