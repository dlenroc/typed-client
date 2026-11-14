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
    async (field) => {
      const { adapter } = mockTransport();
      const call = c.bind(
        c.endpoint("/users", {
          method: "POST",
          [field]: invalid,
          responses: { 200: "json" },
        }),
        adapter,
      );

      await expect(call()).rejects.toMatchObject({
        code: "request-schema",
        field,
        reason: "issues",
        issues,
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
      code: "request-schema",
      field: "body",
      reason: "exception",
      cause,
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("reject an empty status list before sending", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint("/users"), adapter);
    const status: number[] = [];

    await expect(get({ status })).rejects.toMatchObject({ code: "request-input" });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("reject a missing path value before sending", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint("/users/:id"), adapter);

    // @ts-expect-error exercise the runtime check for untyped callers
    const result = get({ status: 200 });

    await expect(result).rejects.toMatchObject({ code: "request-url" });
    expect(adapter).not.toHaveBeenCalled();
  });

  test("classify invalid headers as preparation errors", async () => {
    const send = vi.fn<typeof fetch>();
    const get = c.bind(
      c.endpoint("/users"),
      fetchTransport({
        baseUrl: "https://api.test/v1",
        fetch: send,
      }),
    );

    await expect(get({ headers: { "bad\nname": "value" }, status: 200 })).rejects.toMatchObject({
      code: "request-prepare",
      url: "https://api.test/v1/users",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("report JSON serialization failures before sending", async () => {
    const send = vi.fn<typeof fetch>();
    const post = c.bind(
      c.endpoint("/users", { method: "POST", responses: { 204: "none" } }),
      fetchTransport({ fetch: send }),
    );

    await expect(post({ body: { id: 1n } })).rejects.toMatchObject({
      code: "request-prepare",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("preserve the cause and effective request context when sending fails", async () => {
    const upstream = new ClientError({ code: "transport", method: "GET" });
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
      cause: upstream,
    });
  });
});

describe("response errors", () => {
  test.each([
    { field: "headers", kind: "none" },
    { field: "body", kind: "json" },
  ] as const)("handle $field schema failures at the right stage", async ({ field, kind }) => {
    const { adapter, response } = mockTransport();
    const get = c.bind(
      c.endpoint("/users", {
        responses: { 200: { body: "json", [field]: invalid } },
      }),
      adapter,
    );

    await expect(get()).rejects.toMatchObject({
      code: "response-schema",
      field,
      reason: "issues",
      issues,
      status: 200,
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
  });

  test.each([
    { status: 418, error: { code: "status", status: 418, expectedStatuses: [200] } },
    { status: 200, error: { code: "response-schema", field: "headers", issues } },
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

    await expect(get()).rejects.toMatchObject({ ...error, cleanupError });
    expect(response.read).toHaveBeenCalledExactlyOnceWith("none");
  });

  test.each([
    { kind: "json", error: { code: "response-decode", kind: "json" } },
    { kind: "none", error: { code: "response-cleanup" } },
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
      headers: {},
      url: response.url,
    });
    expect(response.read).toHaveBeenCalledExactlyOnceWith(kind);
  });
});

test("ClientError preserves structured diagnostics through JSON serialization", () => {
  const diagnostics = {
    code: "response-schema",
    field: "body",
    reason: "issues",
    issues,
    method: "GET",
    url: "/users/7",
    status: 200,
    headers: {},
    meta: { operationId: "getUser" },
  } as const;
  const error = new ClientError({ ...diagnostics, cause });

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(ClientError);
  expect(error.cause).toBe(cause);
  expect(error.meta).toBe(diagnostics.meta);
  expect(error.message).toMatch(/body.*1 issue.*200/);
  expect(error.stack).toEqual(expect.any(String));
  expect(JSON.parse(JSON.stringify(error))).toMatchObject({ name: "ClientError", ...diagnostics });
});
