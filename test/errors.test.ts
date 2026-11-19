import { inspect } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { c, ClientError } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { mockTransport, schema } from "./fixtures.ts";

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
      const call = c.bind(
        c.endpoint("/users", {
          method: "POST",
          [part]: invalid,
          responses: { 200: "json" },
        }),
        adapter,
      );

      await expect(call()).rejects.toMatchObject({
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
        body: rejected,
        responses: { 200: "json" },
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
      c.endpoint("/users", { method: "POST", responses: { 204: "none" } }),
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

    await expect(get({ unchecked: true, method: "PATCH", status: 200 })).rejects.toMatchObject({
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
        responses: { 200: { body: "json", [part]: invalid } },
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
      read: () => {
        throw cleanupError;
      },
    });
    const get = c.bind(
      c.endpoint("/users", {
        responses: { 200: { body: "json", headers: invalid } },
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
    const { adapter, response } = mockTransport({ status });
    const discard = vi.fn(async () => {});
    Object.assign(response, { discard });
    const get = c.bind(c.endpoint("/users", { responses: { 200: invalid } }), adapter);

    await expect(get()).rejects.toBeInstanceOf(ClientError);
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
    expect(discard).toHaveBeenCalledTimes(discards);
  });

  test.each([
    { kind: "json", error: { code: "response" } },
    { kind: "none", error: { code: "transport" } },
  ] as const)("classify a failed $kind read without retrying", async ({ kind, error }) => {
    const { adapter, response } = mockTransport({
      read: () => {
        throw cause;
      },
    });
    const get = c.bind(c.endpoint("/users", { responses: { 200: kind } }), adapter);

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

test("ClientError preserves structured diagnostics through JSON serialization", async () => {
  const meta = { operationId: "getUser" };
  const { adapter } = mockTransport();
  const get = c.bind(
    c.endpoint("/users/7", { meta, responses: { 200: schema(() => ({ issues })) } }),
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
      c.endpoint("/users/7", { responses: { 200: schema(() => ({ issues: twoIssues })) } }),
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

  test("give the request URL with its query and fragment", async () => {
    const offline = new Error("offline");
    const get = c.bind(
      c.endpoint("/users?page=2#top", { responses: { 200: "none" } }),
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
    expect(error.message).toBe("Cannot build request URL: Missing path parameter: id");
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
