import { inspect } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { c, ClientError } from "@dlenroc/typed-client";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import type { APIResponse } from "playwright-core";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { mockTransport, recorder, schema, users, withToken } from "./fixtures.ts";

const issues = [{ path: ["name"], message: "Expected string" }];
const cause = new Error("validator failed");
const invalid = schema(() => ({ issues }));
const rejected = schema(async () => {
  throw cause;
});

describe("request errors", () => {
  test.each(["path", "query", "headers", "body"] as const)(
    "reject %s schema issues before calling the transport",
    async (part) => {
      const { adapter } = mockTransport();
      const definition = { method: "POST", responses: { 200: c.json() } };

      const result =
        part === "body"
          ? c.bind(c.endpoint("/users", { ...definition, body: c.json(invalid) }), adapter)()
          : c.bind(c.endpoint("/users", { ...definition, [part]: invalid }), adapter)();

      await expect(result).rejects.toMatchObject({
        code: "request",
        schema: part,
        issues,
        cause: undefined,
      });
      expect(adapter).not.toHaveBeenCalled();
    },
  );

  test("preserve an asynchronous request validator's exception", async () => {
    const { adapter } = mockTransport();
    const call = c.bind(
      c.endpoint("/users", {
        body: c.json(rejected),
        responses: { 200: c.json() },
      }),
      adapter,
    );

    await expect(call()).rejects.toMatchObject({
      code: "request",
      schema: "body",
      issues: undefined,
      cause,
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("reject an empty status list before sending", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint("/users"), adapter);
    const status: number[] = [];

    await expect(get({ status })).rejects.toMatchObject({
      code: "request",
      schema: undefined,
      cause: expect.any(TypeError),
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("reject a missing path value before sending", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint("/users/{id}"), adapter);

    // @ts-expect-error exercise the runtime check for untyped callers
    const result = get({ status: 200 });

    await expect(result).rejects.toMatchObject({ code: "request", schema: undefined });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("report a header that Fetch rejects as a transport error", async () => {
    const get = c.bind(c.endpoint("/users"), fetchTransport({ baseUrl: "https://api.test/v1" }));

    await expect(get({ headers: { "bad\nname": "value" }, status: 200 })).rejects.toMatchObject({
      code: "transport",
      url: "https://api.test/v1/users",
      cause: { name: "TypeError" },
    });
  });

  test("report JSON serialization failures before sending", async () => {
    const send = vi.fn<typeof fetch>();
    const post = c.bind(
      c.endpoint("/users", { method: "POST", body: c.json(), responses: { 204: c.none() } }),
      fetchTransport({ fetch: send }),
    );

    await expect(post({ body: { id: 1n } })).rejects.toMatchObject({ code: "request" });
    expect(send).not.toHaveBeenCalled();
  });

  test("preserve the cause and effective request context when sending fails", async () => {
    const upstream = new Error("connection reset");
    const meta = { operationId: "getUser" };
    const get = c.bind(
      c.endpoint("/users", { meta }),
      fetchTransport({
        baseUrl: "https://api.test/v1",
        fetch: vi.fn<typeof fetch>().mockRejectedValue(upstream),
      }),
    );

    await expect(get({ method: c.raw("PATCH"), status: 200 })).rejects.toMatchObject({
      code: "transport",
      method: "PATCH",
      url: "https://api.test/v1/users",
      meta,
      status: undefined,
      cause: upstream,
    });
  });
});

describe("response errors", () => {
  test.each([
    { part: "headers", kind: "none" },
    { part: "body", kind: "json" },
  ] as const)("handle $part schema failures at the right stage", async ({ part, kind }) => {
    const { adapter, response } = mockTransport();
    const get = c.bind(
      c.endpoint("/users", {
        responses: {
          200: part === "body" ? { body: c.json(invalid) } : { body: c.json(), headers: invalid },
        },
      }),
      adapter,
    );

    await expect(get()).rejects.toMatchObject({
      code: "response",
      schema: part,
      issues,
      status: 200,
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
  });

  test.each([
    { status: 418, error: { code: "status", status: 418, message: /418 \(expected 200\)/ } },
    { status: 200, error: { code: "response", schema: "headers", issues } },
  ])("retain the primary failure when discarding HTTP $status fails", async ({ status, error }) => {
    const cleanupError = new Error("cannot discard");
    const { adapter, response } = mockTransport({
      status,
      headers: { "content-type": "application/octet-stream" },
      read: () => {
        throw cleanupError;
      },
    });
    const get = c.bind(
      c.endpoint("/users", {
        responses: { 200: { body: c.json(), headers: invalid } },
      }),
      adapter,
    );

    await expect(get()).rejects.toMatchObject({
      ...error,
      message: "message" in error ? expect.stringMatching(error.message) : expect.any(String),
      cleanupError,
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith("none");
  });

  test.each([
    { name: "an unread response with read(none)", status: 418, kind: "none", discards: 0 },
    {
      name: "a read value that a schema rejects with discard()",
      status: 200,
      kind: "json",
      discards: 1,
    },
  ] as const)("release $name", async ({ status, kind, discards }) => {
    const { adapter, response } = mockTransport({
      status,
      headers: { "content-type": "application/octet-stream" },
    });
    const discard = vi.fn(async () => {});
    Object.assign(response, { discard });
    const get = c.bind(c.endpoint("/users", { responses: { 200: c.json(invalid) } }), adapter);

    await expect(get()).rejects.toBeInstanceOf(ClientError);
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
    expect(discard).toHaveBeenCalledTimes(discards);
  });

  test.each([
    { kind: "json", body: c.json(), error: { code: "response" } },
    { kind: "none", body: c.none(), error: { code: "transport" } },
  ] as const)("classify a failed $kind read without retrying", async ({ kind, body, error }) => {
    const { adapter, response } = mockTransport({
      read: () => {
        throw cause;
      },
    });
    const get = c.bind(c.endpoint("/users", { responses: { 200: body } }), adapter);

    await expect(get()).rejects.toMatchObject({
      ...error,
      cause,
      status: 200,
      schema: undefined,
      url: response.url,
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
  });
});

describe("the response in errors", () => {
  const textRead = (text: string) => (kind: string) => (kind === "text" ? text : undefined);

  test.each([
    { name: "a JSON type", contentType: "application/problem+json; charset=utf-8" },
    { name: "a text type", contentType: "text/html" },
    { name: "an XML type", contentType: "application/atom+xml" },
    { name: "no type", contentType: undefined },
  ])("a status error reads the body of $name as text", async ({ contentType }) => {
    const headers = contentType === undefined ? {} : { "content-type": contentType };
    const { adapter, response } = mockTransport({
      status: 500,
      headers,
      read: textRead('{"error":"boom"}'),
    });
    const get = c.bind(c.endpoint("/users", { responses: { 200: c.json() } }), adapter);

    const error: unknown = await get().catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError && error.code === "status");
    expect(error.headers).toBe(headers);
    expect(error.body).toBe('{"error":"boom"}');
    expect(error.message).toBe(
      "Unexpected status 500 (expected 200) for GET https://api.test/users/7\n" +
        '{"error":"boom"}',
    );
    expect(response.read).toHaveBeenCalledExactlyOnceWith("text");
  });

  test("a status error discards a body of another type", async () => {
    const { adapter, response } = mockTransport({
      status: 500,
      headers: { "content-type": "image/png" },
    });
    const get = c.bind(c.endpoint("/users", { responses: { 200: c.json() } }), adapter);

    await expect(get()).rejects.toMatchObject({
      code: "status",
      headers: { "content-type": "image/png" },
      body: undefined,
      message: "Unexpected status 500 (expected 200) for GET https://api.test/users/7",
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith("none");
  });

  test("the message shows the first 1000 characters without URL credentials", async () => {
    const url = "https://u:secret@api.test/users/7";
    const text = `${url} ${"x".repeat(2000)}`;
    const { adapter, response } = mockTransport({ status: 500, read: textRead(text) });
    Object.assign(response, { url });
    const get = c.bind(c.endpoint("/users/7", { responses: { 200: c.none() } }), adapter);

    const error: unknown = await get().catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError && error.code === "status");
    expect(error.body).toBe(text);

    const [, shown] = error.message.split("\n");
    expect(shown).toBe(`https://api.test/users/7 ${"x".repeat(1000 - url.length - 1)}…`);
    expect(error.message).not.toContain("secret");
  });

  test.each([
    { name: "a failed read", readFails: true, disposeFails: false },
    { name: "a failed read and release", readFails: true, disposeFails: true },
    { name: "a failed release", readFails: false, disposeFails: true },
    { name: "explicit discard", disposeFails: true, discard: true },
    { name: "a binary status response", disposeFails: true, type: "application/octet-stream" },
    { name: "a rejected header schema", disposeFails: true, status: 200 },
  ])("retain the native cleanup error after $name", async ({
    readFails, disposeFails, discard = false, type = "text/plain", status = 500,
  }) => {
    const disposeError = new Error("dispose failed");
    const native = {
      status: () => status,
      url: () => "https://api.test/users",
      headersArray: () => [{ name: "content-type", value: type }],
      timing: () => ({}),
      serverAddr: async () => null,
      securityDetails: async () => null,
      text: async () => {
        if (readFails) {
          throw new Error("bad bytes");
        }

        return "boom";
      },
      dispose: async () => {
        if (disposeFails) {
          throw disposeError;
        }
      },
    } as unknown as APIResponse;
    const get = c.bind(
      c.endpoint("/users", { responses: { 200: { headers: invalid, body: c.json() } } }),
      playwrightTransport({ context: { fetch: async () => native } }),
    );

    const error: unknown = await get({ discard }).catch((caught: unknown) => caught);

    expect.assert(error instanceof ClientError);
    expect(error).toMatchObject({ code: status === 200 ? "response" : "status", status, body: undefined });
    expect(error.cleanupError).toBe(disposeFails ? disposeError : undefined);
  });

  test.each([
    {
      name: "a headers schema",
      responses: { 200: { body: c.json(), headers: invalid } },
      read: undefined,
      expected: { schema: "headers", body: undefined },
    },
    {
      name: "a body schema",
      responses: { 200: c.json(invalid) },
      read: undefined,
      expected: { schema: "body", body: { id: 7 } },
    },
    {
      name: "the decoder",
      responses: { 200: c.json() },
      read: () => {
        throw cause;
      },
      expected: { schema: undefined, body: undefined },
    },
  ] as const)("a response error from $name keeps the headers", async ({ responses, read, expected }) => {
    const headers = { "x-request-id": "r1" };
    const { adapter } = mockTransport({ headers, ...(read && { read }) });
    const get = c.bind(c.endpoint("/users", { responses }), adapter);

    const error: unknown = await get().catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError && error.code === "response");
    expect(error.headers).toBe(headers);
    expect(error).toMatchObject(expected);
  });

  test("other errors have no response", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint("/users/{id}", { responses: { 200: c.json() } }), adapter);

    await expect(get({ path: {} as { id: string } })).rejects.toMatchObject({
      code: "request",
      headers: undefined,
      body: undefined,
    });
  });
});

test("ClientError preserves structured diagnostics through JSON serialization", async () => {
  const meta = { operationId: "getUser" };
  const { adapter } = mockTransport();
  const get = c.bind(
    c.endpoint("/users/7", { meta, responses: { 200: c.json(schema(() => ({ issues }))) } }),
    adapter,
  );

  const error: unknown = await get().catch((failure: unknown) => failure);

  expect.assert(error instanceof ClientError);
  expect(error).toBeInstanceOf(Error);
  expect(error.meta).toBe(meta);
  expect(error.message).toMatch(/body.*1 issue.*200/);
  expect(error.stack).toMatch(/^ClientError: Response body/);

  expect(Object.keys(error)).toEqual([
    "code",
    "method",
    "url",
    "meta",
    "status",
    "schema",
    "issues",
    "headers",
    "body",
    "cause",
  ]);
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    code: "response",
    schema: "body",
    issues,
    method: "GET",
    url: "https://api.test/users/7",
    status: 200,
    meta,
    headers: {},
    body: { id: 7 },
  });
});

function clientError(
  summary: string,
  url: string | undefined,
  cause?: unknown,
  issues?: ConstructorParameters<typeof ClientError>[0]["issues"],
) {
  return new ClientError({ code: "transport", summary, method: "GET", url, meta: {}, issues, cause });
}

describe("error messages", () => {
  test("name the request and list the issues", async () => {
    const twoIssues = [
      { path: ["user", { key: "id" }], message: "Expected number" },
      { message: "Second issue" },
    ];
    const { adapter } = mockTransport();
    const get = c.bind(
      c.endpoint("/users/7", { responses: { 200: c.json(schema(() => ({ issues: twoIssues }))) } }),
      adapter,
    );

    const error: unknown = await get().catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError);
    expect(error.message).toBe(
      "Response body schema reported 2 issues (status 200) for GET https://api.test/users/7\n" +
        "  - user.id: Expected number\n" +
        "  - Second issue",
    );
  });

  test("name the endpoint template before the URL exists", async () => {
    const { adapter } = mockTransport();
    const post = c.bind(
      c.endpoint("/users/{id}", {
        method: "POST",
        path: schema((value) =>
          typeof (value as { id?: unknown }).id === "number"
            ? { value: value as { id: number } }
            : { issues: [{ path: ["id"], message: "Expected number" }] },
        ),
        responses: { 200: c.none() },
      }),
      adapter,
    );

    const error: unknown = await post({ path: { id: "x" } }).catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError);
    expect(error.url).toBe(undefined);
    expect(error.message).toBe(
      "Request path schema reported 1 issue for POST /users/{id}\n  - id: Expected number",
    );
  });

  test("give the request URL with its query and fragment", async () => {
    const offline = new Error("offline");
    const get = c.bind(
      c.endpoint("/users?page=2#top", { responses: { 200: c.none() } }),
      fetchTransport({
        baseUrl: "https://api.test",
        fetch: async () => {
          throw offline;
        },
      }),
    );

    const error: unknown = await get().catch((failure: unknown) => failure);

    expect.assert(error instanceof ClientError);
    expect(error.message).toBe(
      "Cannot get response for GET https://api.test/users?page=2#top: offline",
    );
  });

  test("give the cause when no issue explains the failure", async () => {
    const get = c.bind(c.endpoint("/users/{id}"), fetchTransport());

    const error: unknown = await get({ path: {} as { id: string }, status: 200 }).catch(
      (failure: unknown) => failure,
    );

    expect.assert(error instanceof ClientError);
    expect(error.message).toBe(
      "Cannot build request URL for GET /users/{id}: Missing path parameter: id",
    );
  });

  test.for([
    {
      name: "URL credentials",
      url: "https://user:secret@api.test/x?page=2",
      cause: undefined,
      expected: "Failed for GET https://api.test/x?page=2",
    },
    {
      name: "a password with a raw @",
      url: "http://u:secret@w@h.test/x",
      cause: undefined,
      expected: "Failed for GET http://h.test/x",
    },
    {
      name: "the request URL credentials inside the cause",
      url: "https://u:secret@h.test/x",
      cause: new Error("Failed to fetch https://u:secret@h.test/x"),
      expected: "Failed for GET https://h.test/x: Failed to fetch https://h.test/x",
    },
    {
      name: "the lines after the first line of the cause",
      url: "/x",
      cause: new Error("connect failed\nAuthorization: secret"),
      expected: "Failed for GET /x: connect failed",
    },
    {
      name: "the credentials of a scheme-relative URL",
      url: "//u:secret@h.test/x",
      cause: undefined,
      expected: "Failed for GET //h.test/x",
    },
  ])("leave $name out of the message", ({ url, cause, expected }) => {
    const { message } = clientError("Failed", url, cause);

    expect(message).toBe(expected);
    expect(message).not.toContain("secret");
  });

  test("give the code of a cause without a message", () => {
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    const cause = new TypeError("fetch failed", { cause: refused });
    const { message } = clientError("Failed", "/x", cause);

    expect(message).toBe("Failed for GET /x: fetch failed (ECONNREFUSED)");
  });

  test("replace the request URL as plain text", () => {
    const url = "https://u:secret@h.test/x?q=$&";
    const { message } = clientError("Failed", url, new Error(`Failed to fetch ${url}`));

    expect(message).toBe(
      "Failed for GET https://h.test/x?q=$&: Failed to fetch https://h.test/x?q=$&",
    );
  });

  test("keep an @ in the query", () => {
    const { message } = clientError("Failed", "https://h.test?email=a@b.test");

    expect(message).toBe("Failed for GET https://h.test?email=a@b.test");
  });

  test("give the path alone for an issue without a message", () => {
    const error = clientError("Request body schema reported 1 issue", undefined, undefined, [
      { path: ["id"], message: "" },
    ]);

    expect(error.message).toBe("Request body schema reported 1 issue\n  - id");
  });

  test("print array indexes in brackets", () => {
    const error = clientError("Failed", undefined, undefined, [
      { path: ["roles", 0, { key: 2 }, "name"], message: "Invalid" },
    ]);

    expect(error.message).toBe("Failed\n  - roles[0][2].name: Invalid");
  });

  test("leave out a path that the message starts with", () => {
    const error = clientError("Failed", undefined, undefined, [
      { path: ["roles", 0], message: "roles[0] must be a string (was 1)" },
      { path: ["id"], message: "identifier is required" },
    ]);

    expect(error.message).toBe(
      "Failed\n" +
        "  - roles[0] must be a string (was 1)\n" +
        "  - id: identifier is required",
    );
  });

  test("give the outer cause alone when the inner cause is empty", () => {
    const { message } = clientError("Failed", "", new Error("outer", { cause: new Error("") }));

    expect(message).toBe("Failed: outer");
  });

  test("give the first line of a string cause", () => {
    const { message } = clientError("Failed", "/x", "aborted\nby the test");

    expect(message).toBe("Failed for GET /x: aborted");
  });

  test("list 10 issues without a count of the rest", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ path: [i], message: "Invalid" }));
    const lines = clientError("Failed", undefined, undefined, ten).message.split("\n");

    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("  - [9]: Invalid");
  });

  test("list at most 10 issues", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: [i], message: "Invalid" }));
    const lines = clientError("Failed", undefined, undefined, many).message.split("\n");

    expect(lines).toHaveLength(12);
    expect(lines[10]).toBe("  - [9]: Invalid");
    expect(lines[11]).toBe("  - … 2 more");
  });

  test("print the public class name", () => {
    const error = clientError("Unexpected status 500", "/x");

    expect(inspect(error)).toMatch(/^ClientError: Unexpected status 500 for GET \/x/);
  });
});

describe("error codes", () => {
  test("a failure of a decorator has the code transport", async () => {
    const { transport } = recorder();
    const failure = new Error("no token");
    const api = c.bind(users, withToken(transport, async () => Promise.reject(failure)));

    const error = await api.get({ path: { id: 1 } }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "transport", method: "GET", url: "/users/1", cause: failure });
  });

  test("a nested call failure belongs to its own endpoint even with shared metadata", async () => {
    const meta = { service: "users" };
    const token = c.endpoint("/token", { meta, responses: { 200: c.none() } });
    const users = c.endpoint("/users", { meta, responses: { 200: c.none() } });
    const getToken = c.bind(token, mockTransport({ status: 503 }).adapter);
    const getUsers = c.bind(
      users,
      withToken(recorder().transport, async () => {
        await getToken();
        return "token";
      }),
    );

    await expect(getUsers()).rejects.toMatchObject({
      code: "transport",
      url: "/users",
      status: undefined,
      cause: { code: "status", status: 503 },
    });
  });

  test("bind converts a built-in transport failure into a ClientError", async () => {
    const cause = new Error("offline");
    const adapter = fetchTransport({
      baseUrl: "https://api.test",
      fetch: async () => {
        throw cause;
      },
    });
    const wrapped: typeof adapter = async (request) => {
      try {
        return await adapter(request);
      } catch (failure) {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(ClientError);
        expect(failure).toHaveProperty("cause", cause);
        throw failure;
      }
    };
    const get = c.bind(c.endpoint("/users"), wrapped);

    const failure: unknown = await get({ status: 200 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({ code: "transport", url: "https://api.test/users", cause });
  });

  test("a nested adapter timeout keeps its code on the inner error", async () => {
    const failure = new DOMException("late", "TimeoutError");
    const token = c.bind(
      c.endpoint("/token"),
      fetchTransport({
        baseUrl: "https://auth.test",
        fetch: async () => {
          throw failure;
        },
      }),
    );
    const users = c.bind(
      c.endpoint("/users"),
      withToken(recorder().transport, async () => {
        await token({ status: 200 });
        return "token";
      }),
    );

    await expect(users({ status: 200 })).rejects.toMatchObject({
      code: "transport",
      url: "/users",
      cause: { code: "timeout", url: "https://auth.test/token", cause: failure },
    });
  });

  test("a decorator's TimeoutError has the code timeout", async () => {
    const { transport } = recorder();
    const failure = Object.assign(new Error("too slow"), { name: "TimeoutError" });
    const api = c.bind(users, withToken(transport, async () => Promise.reject(failure)));

    await expect(api.get({ path: { id: 1 } })).rejects.toMatchObject({
      code: "timeout",
      cause: failure,
      message: "Timed out waiting for response for GET /users/1: too slow",
    });
  });

  test("a status outside the accepted set has the code status", async () => {
    const { transport } = recorder();

    await expect(c.bind(users, transport).get({ path: { id: 1 }, status: 200 })).rejects.toMatchObject({
      code: "status",
      status: 204,
    });
  });
});
