import { appendQuery } from "../shared/url.js";
import type { BoundContract, Endpoint, EndpointTree, ValidateBinding } from "./contract-types.js";
import { renderPath } from "./endpoint.js";
import {
  ClientError,
  FailureWithCleanupError,
  ResponseCleanupError,
  preserveCleanupError,
  transportError,
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

type Meta = Endpoint["meta"];

function schemaError(
  method: string,
  url: string | undefined,
  meta: Meta,
  status: number | undefined,
  schema: "path" | "query" | "headers" | "body",
  issues: readonly StandardIssue[] | undefined,
  cause: unknown,
): ClientError {
  const outcome =
    issues === undefined
      ? "threw"
      : `reported ${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  return status === undefined
    ? new ClientError(
        "request",
        `Request ${schema} schema ${outcome}`,
        method,
        url,
        meta,
        undefined,
        schema,
        issues,
        cause,
      )
    : new ClientError(
        "response",
        `Response ${schema} schema ${outcome} (status ${status})`,
        method,
        url,
        meta,
        status,
        schema,
        issues,
        cause,
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

  for (let i = 0; i < expectation.length; i++) {
    const status = expectation[i]!;
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
    if (!bodyWasRead) {
      await handle.read("none");
    } else if (handle.discard) {
      await handle.discard();
    }
  } catch (cleanupError) {
    primary.cleanupError = cleanupError;
  }

  throw primary;
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
  const meta = endpoint.meta;

  if (Array.isArray(expectedStatus) && expectedStatus.length === 0) {
    throw new ClientError(
      "request",
      "Invalid call input",
      method,
      undefined,
      meta,
      undefined,
      undefined,
      undefined,
      new TypeError("status must not be empty"),
    );
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
        throw schemaError(method, undefined, meta, undefined, "path", undefined, cause);
      }

      if (result.issues) {
        throw schemaError(method, undefined, meta, undefined, "path", result.issues, undefined);
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
        throw schemaError(method, undefined, meta, undefined, "query", undefined, cause);
      }

      if (result.issues) {
        throw schemaError(method, undefined, meta, undefined, "query", result.issues, undefined);
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
        throw schemaError(method, undefined, meta, undefined, "headers", undefined, cause);
      }

      if (result.issues) {
        throw schemaError(method, undefined, meta, undefined, "headers", result.issues, undefined);
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
        throw schemaError(method, undefined, meta, undefined, "body", undefined, cause);
      }

      if (result.issues) {
        throw schemaError(method, undefined, meta, undefined, "body", result.issues, undefined);
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
    throw new ClientError(
      "request",
      "Cannot build request URL",
      method,
      undefined,
      meta,
      undefined,
      undefined,
      undefined,
      cause,
    );
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
    meta,
    input,
  };

  let handle: TransportResponse<any, any>;
  try {
    handle = await transport(transportRequest);
  } catch (failure) {
    // A transport raises this call's own error with the endpoint's metadata.
    if (failure instanceof ClientError && failure.meta === meta) {
      throw failure;
    }

    throw transportError(true, method, transportRequest.url, meta, failure);
  }

  const responseUrl = handle.url;

  const status = handle.status;
  const responseSpec = endpoint.responses[status];
  const accepted =
    expectedStatus === undefined
      ? responseSpec !== undefined
      : typeof expectedStatus === "number"
        ? status === expectedStatus
        : expectedStatus.includes(status);

  if (!accepted) {
    const expected =
      expectedStatus === undefined
        ? Object.keys(endpoint.responses).join(", ")
        : typeof expectedStatus === "number"
          ? expectedStatus
          : expectedStatus.join(", ");

    return rejectResponse(
      handle,
      new ClientError(
        "status",
        `Unexpected status ${status} (expected ${expected})`,
        method,
        responseUrl,
        meta,
        status,
        undefined,
        undefined,
        undefined,
      ),
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
      return rejectResponse(
        handle,
        schemaError(method, responseUrl, meta, status, "headers", undefined, cause),
      );
    }

    if (result.issues) {
      return rejectResponse(
        handle,
        schemaError(method, responseUrl, meta, status, "headers", result.issues, undefined),
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
    const wrapped =
      kind === "none" || cleanupFailed
        ? new ClientError(
            "transport",
            `Cannot release response (status ${status})`,
            method,
            responseUrl,
            meta,
            status,
            undefined,
            undefined,
            cleanupFailed ? cause.cause : cause,
          )
        : new ClientError(
            "response",
            `Cannot decode ${kind} response (status ${status})`,
            method,
            responseUrl,
            meta,
            status,
            undefined,
            undefined,
            cause,
          );

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
        schemaError(method, responseUrl, meta, status, "body", undefined, cause),
        true,
      );
    }

    if (result.issues) {
      return rejectResponse(
        handle,
        schemaError(method, responseUrl, meta, status, "body", result.issues, undefined),
        true,
      );
    }

    responseBody = result.value;
  }

  if (handle.transport === undefined) {
    return { status, url: responseUrl, headers: responseHeaders, body: responseBody };
  }

  return {
    status,
    url: responseUrl,
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

    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      group[key] = visit(entries[key]);
    }

    return group;
  }

  return visit(contract) as BoundContract<Contract, Adapter>;
}
