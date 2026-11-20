import { appendQuery } from "../http.js";
import type { BoundContract, CheckBinding } from "./bind-types.js";
import type { Endpoint } from "./endpoint-types.js";
import { compilePath, type PathPlan, referenceOf, renderPath } from "./endpoint.js";
import {
  ClientError,
  transportError,
  type ClientErrorFields,
  failureCause,
  isTimeoutError,
  preserveCleanupError,
  ResponseCleanupError,
  schemaError,
} from "./errors.js";
import { isRaw, rawParts } from "./raw.js";
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

const isContentType = (name: string) => name.toLowerCase() === "content-type";

/**
 * A transport and its decorators get only headers with a value or `null`.
 * With `dropContentType`, a multipart call also loses its Content-Type, so
 * the encoder's boundary is used, unless the last one given is `null`.
 * With `jsonContentType`, a call without a Content-Type gets
 * `application/json`. The headers are copied only when something changes.
 */
function cleanHeaders(
  headers: HeaderInput | undefined,
  dropContentType: boolean,
  jsonContentType: boolean,
): HeaderInput | undefined {
  if (headers === undefined) {
    return jsonContentType ? { "content-type": "application/json" } : undefined;
  }

  const checkContentType = dropContentType || jsonContentType;
  let undefinedFound = false;
  let dropping = false;
  let contentTypeSet = false;

  for (const name in headers) {
    const value = headers[name];
    if (value === undefined) {
      undefinedFound = true;
    } else if (checkContentType && isContentType(name)) {
      contentTypeSet = true;
      dropping = dropContentType && value !== null;
    }
  }

  const addJson = jsonContentType && !contentTypeSet;
  if (!undefinedFound && !dropping && !addJson) {
    return headers;
  }

  const kept: Record<string, HeaderInput[string]> = {};

  for (const name in headers) {
    const value = headers[name];
    if (value !== undefined && !(dropping && isContentType(name))) {
      kept[name] = value;
    }
  }

  if (addJson) {
    kept["content-type"] = "application/json";
  }

  return kept;
}

// A status error reads these types, or a body without a type, as text.
const textualType =
  /^\s*(?:text\/|application\/(?:[^;\s]*\+)?(?:json|xml|x-www-form-urlencoded)\s*(?:;|$))/i;

/**
 * Release the response of a status error. Read the body as text if its
 * type is textual. If that read fails, the body is `undefined`, and only a
 * failed release sets `cleanupError`.
 */
async function rejectStatus(
  handle: TransportResponse<any, any>,
  discard: boolean,
  fields: Omit<ClientErrorFields, "headers" | "body">,
): Promise<never> {
  const headers = handle.headers;
  const contentType = headers["content-type"];
  const textual = !discard && (contentType === undefined || textualType.test(contentType));
  let body: string | undefined;
  let readFailed = false;
  let readFailure: unknown;

  try {
    if (textual) {
      const text: unknown = await handle.read("text");
      if (typeof text === "string") {
        body = text;
      }
    } else {
      await handle.read("none");
    }
  } catch (failure) {
    readFailed = true;
    readFailure = failure;
  }

  const error = new ClientError({ ...fields, headers, body });

  if (readFailed) {
    const cause = failureCause(readFailure);
    if (cause instanceof ResponseCleanupError) {
      error.cleanupError = cause.cause;
    } else if (!textual) {
      error.cleanupError = readFailure;
    } else {
      preserveCleanupError(error, readFailure);
    }
  }

  throw error;
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
    primary.cleanupError = cleanupError instanceof ResponseCleanupError ? cleanupError.cause : cleanupError;
  }

  throw primary;
}

/**
 * Send one call: validate and prepare the request, call the transport,
 * check the status, then decode and validate the response.
 */
async function call(
  endpoint: Endpoint,
  plan: PathPlan,
  transport: Transport<any, any, any, any>,
  input?: Record<string, unknown>,
): Promise<unknown> {
  const discard = input?.discard === true;
  const expectedStatus = input?.status as number | readonly number[] | undefined;
  const methodInput = input?.method;
  const method = isRaw(methodInput) ? (rawParts(methodInput)[0] as string) : endpoint.method;
  const meta = endpoint.meta;
  const request = endpoint.request;

  if (Array.isArray(expectedStatus) && expectedStatus.length === 0) {
    throw new ClientError({
      code: "request",
      summary: "Invalid call input",
      method,
      template: endpoint.template,
      meta,
      cause: new TypeError("status must not be empty"),
    });
  }

  let path = input?.path;
  let query = input?.query;
  let headers = input?.headers;
  let body = input?.body;
  let bodyKind = request.body.kind;

  // A raw part skips its schema and its encoding.
  const rawPath = isRaw(path);
  if (rawPath) {
    path = rawParts(path as never)[0];
  }

  const rawQuery = isRaw(query);
  if (rawQuery) {
    query = rawParts(query as never)[0];
  }

  const rawHeaders = isRaw(headers);
  if (rawHeaders) {
    headers = rawParts(headers as never)[0];
  }

  // A raw string for a JSON body is the JSON text.
  const rawBody = isRaw(body);
  let rawJsonText = false;
  if (rawBody) {
    const [rawValue, rawKind] = rawParts(body as never);
    body = rawValue;
    rawJsonText = rawKind === undefined && bodyKind === "json" && typeof body === "string";
    bodyKind = rawJsonText ? "text" : (rawKind ?? bodyKind);
  }

  if (request.path !== undefined && !rawPath) {
    let result = check(request.path, path);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      throw schemaError(
        method,
        undefined,
        endpoint.template,
        meta,
        undefined,
        "path",
        result.issues,
        result.cause,
      );
    }

    path = result.value;
  }

  if (request.query !== undefined && !rawQuery) {
    let result = check(request.query, query);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      throw schemaError(
        method,
        undefined,
        endpoint.template,
        meta,
        undefined,
        "query",
        result.issues,
        result.cause,
      );
    }

    query = result.value;
  }

  if (request.headers !== undefined && !rawHeaders) {
    let result = check(request.headers, headers);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      throw schemaError(
        method,
        undefined,
        endpoint.template,
        meta,
        undefined,
        "headers",
        result.issues,
        result.cause,
      );
    }

    headers = result.value;
  }

  if (request.body.schema !== undefined && !rawBody) {
    let result = check(request.body.schema, body);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      throw schemaError(
        method,
        undefined,
        endpoint.template,
        meta,
        undefined,
        "body",
        result.issues,
        result.cause,
      );
    }

    body = result.value;
  }

  let url: string;
  let reference: Reference;

  try {
    if (rawPath && typeof path === "string") {
      reference = referenceOf(path);
      url = appendQuery(path, query as QueryInput | undefined);
    } else {
      reference = plan.reference;
      url = appendQuery(renderPath(plan, path), query as QueryInput | undefined);
    }
  } catch (cause) {
    throw new ClientError({
      code: "request",
      summary: "Cannot build request URL",
      method,
      template: endpoint.template,
      meta,
      cause,
    });
  }

  if (headers !== undefined || rawJsonText) {
    headers = cleanHeaders(
      headers as HeaderInput | undefined,
      !rawHeaders && bodyKind === "multipart" && body !== undefined,
      rawJsonText,
    );
  }

  const transportRequest: TransportRequest = {
    endpoint: endpoint as never,
    method,
    url,
    reference,
    headers: headers as HeaderInput | undefined,
    bodyKind: bodyKind as TransportRequest["bodyKind"],
    body: body as TransportRequest["body"],
    discard,
    timeout: input?.timeout as number | undefined,
    follow: input?.follow === true,
    status: expectedStatus,
    options: input?.transport,
  };

  let handle: TransportResponse<any, any>;

  try {
    handle = await transport(transportRequest);
  } catch (failure) {
    throw transportError(transportRequest, failure);
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

    return rejectStatus(handle, discard, {
      code: "status",
      summary: `Unexpected status ${status} (expected ${expected})`,
      method,
      url: responseUrl,
      meta,
      status,
    });
  }

  let responseHeaders: unknown = handle.headers;

  if (responseSpec?.headers) {
    let result = check(responseSpec.headers, responseHeaders);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      return rejectResponse(
        handle,
        schemaError(
          method,
          responseUrl,
          endpoint.template,
          meta,
          status,
          "headers",
          result.issues,
          result.cause,
          handle.headers,
        ),
      );
    }

    responseHeaders = result.value;
  }

  const kind = discard || responseSpec === undefined ? "none" : responseSpec.body.kind;
  let responseBody: unknown;

  try {
    responseBody = await handle.read(kind);
  } catch (failure) {
    const cause = failureCause(failure);
    if (isTimeoutError(cause)) {
      throw preserveCleanupError(
        new ClientError({
          code: "timeout",
          summary: "Timed out reading response",
          method,
          url: responseUrl,
          meta,
          status,
          cause,
        }),
        failure,
      );
    }

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
        headers: released ? undefined : handle.headers,
        cause: cleanupFailed ? cause.cause : cause,
      }),
      failure,
    );
  }

  if (!discard && responseSpec?.body.schema !== undefined) {
    let result = check(responseSpec.body.schema, responseBody);
    if ("then" in result) {
      result = await result;
    }

    if (!result.ok) {
      return rejectResponse(
        handle,
        schemaError(
          method,
          responseUrl,
          endpoint.template,
          meta,
          status,
          "body",
          result.issues,
          result.cause,
          handle.headers,
          responseBody,
        ),
        true,
      );
    }

    responseBody = result.value;
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
export function bind<const Contract extends object, Adapter extends AnyTransport>(
  contract: Contract,
  transport: Adapter & CheckBinding<NoInfer<Contract>, NoInfer<Adapter>>,
): BoundContract<Contract, Adapter> {
  function visit(node: unknown): unknown {
    const endpoint = node as Endpoint;
    if (typeof endpoint?.method === "string") {
      // Compiled once per binding, when `bind` runs.
      const plan = compilePath(endpoint.template);
      return (input?: Record<string, unknown>) =>
        call(endpoint, plan, transport as Transport<any, any, any, any>, input);
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
