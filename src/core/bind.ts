import { appendQuery } from "../http.js";
import type { BoundContract, EndpointTree, ValidateBinding } from "./bind-types.js";
import type { Endpoint } from "./endpoint-types.js";
import { referenceOf, renderPath } from "./endpoint.js";
import {
  ClientError,
  failureCause,
  preserveCleanupError,
  ResponseCleanupError,
  schemaError,
  transportError,
} from "./errors.js";
import type {
  AnyTransport,
  HeaderInput,
  QueryInput,
  Reference,
  StandardIssue,
  StandardSchemaV1,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./types.js";

const ONLY_NONE = ["none"] as const;

type SchemaCheck =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly issues: readonly StandardIssue[] | undefined;
      readonly cause: unknown;
    };

function outcome(result: {
  readonly value?: unknown;
  readonly issues?: readonly StandardIssue[] | undefined;
}): SchemaCheck {
  return result.issues
    ? { ok: false, issues: result.issues, cause: undefined }
    : { ok: true, value: result.value };
}

function thrown(cause: unknown): SchemaCheck {
  return { ok: false, issues: undefined, cause };
}

/**
 * Run a schema. The result has the output value, or the issues that the
 * schema reported, or the error that it threw as `cause`. A schema that
 * validates synchronously gives a synchronous result, so the call has no
 * extra await.
 */
function check(schema: unknown, value: unknown): SchemaCheck | Promise<SchemaCheck> {
  let result;

  try {
    result = (schema as StandardSchemaV1)["~standard"].validate(value);
  } catch (cause) {
    return thrown(cause);
  }

  return "then" in result ? result.then(outcome, thrown) : outcome(result);
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

/**
 * Send one call: validate and prepare the request, call the transport,
 * check the status, then decode and validate the response.
 */
async function call(
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
    throw new ClientError({
      code: "request",
      summary: "Invalid call input",
      method,
      meta,
      cause: new TypeError("status must not be empty"),
    });
  }

  let path = input?.path;
  let query = input?.query;
  let headers = input?.headers;
  let body = input?.body;

  if (!unchecked) {
    if (endpoint.pathSchema !== undefined) {
      let result = check(endpoint.pathSchema, path);
      if ("then" in result) {
        result = await result;
      }

      if (!result.ok) {
        throw schemaError(method, undefined, meta, undefined, "path", result.issues, result.cause);
      }

      path = result.value;
    }

    if (endpoint.querySchema !== undefined) {
      let result = check(endpoint.querySchema, query);
      if ("then" in result) {
        result = await result;
      }

      if (!result.ok) {
        throw schemaError(method, undefined, meta, undefined, "query", result.issues, result.cause);
      }

      query = result.value;
    }

    if (endpoint.headersSchema !== undefined) {
      let result = check(endpoint.headersSchema, headers);
      if ("then" in result) {
        result = await result;
      }

      if (!result.ok) {
        throw schemaError(method, undefined, meta, undefined, "headers", result.issues, result.cause);
      }

      headers = result.value;
    }

    if (endpoint.body.schema !== undefined) {
      let result = check(endpoint.body.schema, body);
      if ("then" in result) {
        result = await result;
      }

      if (!result.ok) {
        throw schemaError(method, undefined, meta, undefined, "body", result.issues, result.cause);
      }

      body = result.value;
    }
  }

  let url: string;
  let reference: Reference;

  try {
    if (unchecked && typeof path === "string") {
      reference = referenceOf(path);
      url = appendQuery(path, query as QueryInput | undefined);
    } else {
      // The first literal part is the start of the written template.
      const plan = endpoint.path;
      reference = referenceOf(typeof plan === "string" ? plan : plan.parts[0]!);
      url = appendQuery(renderPath(plan, path), query as QueryInput | undefined);
    }
  } catch (cause) {
    throw new ClientError({
      code: "request",
      summary: "Cannot build request URL",
      method,
      meta,
      cause,
    });
  }

  const bodyKind = unchecked ? (input?.bodyKind ?? endpoint.body.kind) : endpoint.body.kind;
  const responseKinds = selectResponseKinds(endpoint, expectedStatus, discard);
  const transportRequest: TransportRequest = {
    method,
    url,
    reference,
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
    const expected = Array.isArray(expectedStatus)
      ? expectedStatus.join(", ")
      : (expectedStatus ?? Object.keys(endpoint.responses).join(", "));

    return rejectResponse(
      handle,
      new ClientError({
        code: "status",
        summary: `Unexpected status ${status} (expected ${expected})`,
        method,
        url: responseUrl,
        meta,
        status,
      }),
    );
  }

  let responseHeaders: unknown = handle.headers;

  if (responseSpec?.headersSchema) {
    let result = check(responseSpec.headersSchema, responseHeaders);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      return rejectResponse(
        handle,
        schemaError(method, responseUrl, meta, status, "headers", result.issues, result.cause),
      );
    }

    responseHeaders = result.value;
  }

  const kind = discard || responseSpec === undefined ? "none" : responseSpec.kind;
  let responseBody: unknown;

  try {
    responseBody = await handle.read(kind);
  } catch (failure) {
    const cause = failureCause(failure);
    const cleanupFailed = cause instanceof ResponseCleanupError;
    const released = kind === "none" || cleanupFailed;
    throw preserveCleanupError(
      new ClientError({
        code: released ? "transport" : "response",
        summary: released
          ? `Cannot release response (status ${status})`
          : `Cannot decode ${kind} response (status ${status})`,
        method,
        url: responseUrl,
        meta,
        status,
        cause: cleanupFailed ? cause.cause : cause,
      }),
      failure,
    );
  }

  if (!discard && responseSpec?.bodySchema !== undefined) {
    let result = check(responseSpec.bodySchema, responseBody);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      return rejectResponse(
        handle,
        schemaError(method, responseUrl, meta, status, "body", result.issues, result.cause),
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

/**
 * Create one function for each endpoint of the tree. Groups keep their
 * keys.
 */
export function bind<const Contract extends EndpointTree, Adapter extends AnyTransport>(
  contract: Contract & ValidateBinding<Contract, Adapter>,
  transport: Adapter,
): BoundContract<Contract, Adapter> {
  function visit(node: unknown): unknown {
    const endpoint = node as Endpoint;
    if (typeof endpoint?.method === "string") {
      return (input?: Record<string, unknown>) =>
        call(endpoint, transport as Transport<any, any, any, any>, input);
    }

    const entries = node as Record<string, unknown>;
    const keys = Object.keys(entries);
    const group: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      group[key] = visit(entries[key]);
    }

    return group;
  }

  return visit(contract) as BoundContract<Contract, Adapter>;
}
