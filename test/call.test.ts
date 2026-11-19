import { describe, expect, test, vi } from "vitest";
import { c } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { mockTransport, recorder, schema, users } from "./fixtures.ts";

describe("endpoint calls", () => {
  test.each(["sync", "async"] as const)(
    "apply %s schemas in request and response order",
    async (mode) => {
      const { adapter, response } = mockTransport();
      const stages: string[] = [];
      const transform = <Output>(name: string, output: Output) =>
        schema((input) => {
          stages.push(name);
          expect(input).toBeDefined();
          const result = { value: output };
          return mode === "async" ? Promise.resolve(result) : result;
        });

      const create = c.bind(
        c.endpoint("/users/{id}", {
          method: "POST",
          path: transform("path", { id: "a/b" }),
          query: transform("query", { tag: ["one", "two"] }),
          headers: transform("headers", { "x-team": "identity" }),
          body: transform("body", { name: "Ada" }),
          responses: {
            200: {
              headers: transform("response headers", { requestId: "r1" }),
              body: transform("response body", { name: "Grace" }),
            },
          },
        }),
        adapter,
      );

      const input = { path: { id: 7 }, query: {}, headers: {}, body: "Ada" };
      const result = await create(input);

      expect(stages).toEqual([
        "path",
        "query",
        "headers",
        "body",
        "response headers",
        "response body",
      ]);
      expect(adapter).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: "POST",
          url: "/users/a%2Fb?tag=one&tag=two",
          headers: { "x-team": "identity" },
          bodyKind: "json",
          body: { name: "Ada" },
        }),
      );
      expect(response.read).toHaveBeenCalledExactlyOnceWith("json");
      expect(result).toStrictEqual({
        status: 200,
        url: response.url,
        headers: { requestId: "r1" },
        body: { name: "Grace" },
      });
    },
  );

  test("a schema can supply an omitted query field", async () => {
    const { adapter } = mockTransport();
    const validate = vi.fn(() => ({ value: "/api/cases/42" }));
    const get = c.bind(
      c.endpoint("/index.php", {
        query: schema(validate),
        responses: { 200: "json" },
      }),
      adapter,
    );

    await get();
    expect(validate).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "/index.php?/api/cases/42" }),
    );
  });

  test("preserve literal query and fragment when adding repeated query fields", async () => {
    const { adapter } = mockTransport();
    const get = c.bind(
      c.endpoint("/users/:/{id}?fixed=1#end", {
        responses: { 200: "json" },
      }),
      adapter,
    );

    await get({
      path: { id: "a/b" },
      query: [
        ["tag", "one"],
        ["tag", "two"],
      ],
    });

    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "/users/:/a%2Fb?fixed=1&tag=one&tag=two#end" }),
    );
  });

  test.for([
    { template: "/files/{name}.json", path: { name: "a b" }, url: "/files/a%20b.json" },
    { template: "/jobs/{id}:cancel", path: { id: "x:y" }, url: "/jobs/x%3Ay:cancel" },
    { template: "/r/{a}-{b}", path: { a: 1, b: 2 }, url: "/r/1-2" },
    { template: "/users/:id/{}", path: {}, url: "/users/:id/{}" },
    { template: "/a/{b?q={c}", path: {}, url: "/a/{b?q={c}" },
  ])("fill parameters in $template", async ({ template, path, url }) => {
    const { adapter } = mockTransport();
    const get = c.bind(c.endpoint(template, { responses: { 200: "json" } }), adapter);

    await get({ path } as never);

    expect(adapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url }));
  });

  test("pass the original inputs and metadata to a nested binding", async () => {
    const { adapter } = mockTransport<{ trace: string }>();
    const meta = { operationId: "createUser" };
    const api = c.bind(
      {
        users: {
          create: c.endpoint("/users", {
            method: "POST",
            meta,
            responses: { 200: "json" },
          }),
        },
      },
      adapter,
    );
    const input = Object.freeze({
      body: { name: "Ada" },
      headers: { accept: "*/*" },
      trace: "r1",
    });

    await api.users.create(input);

    expect(adapter).toHaveBeenCalledTimes(1);
    const [sent] = adapter.mock.calls[0]!;
    expect(sent.body).toBe(input.body);
    expect(sent.headers).toBe(input.headers);
    expect(sent.input).toBe(input);
    expect(sent.meta).toBe(meta);
  });

  test("recognize schemas with their own body and kind fields", async () => {
    const { adapter, response } = mockTransport();
    const parse = { ...schema(() => ({ value: { name: "Ada" } })), kind: "text" as const };
    const decode = { ...schema(() => ({ value: "Ada" })), body: "none" as const };
    const call = c.bind(
      c.endpoint("/users", {
        method: "POST",
        body: parse,
        responses: { 200: decode },
      }),
      adapter,
    );

    await expect(call({ body: "Ada" })).resolves.toMatchObject({ body: "Ada" });

    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bodyKind: "json", body: { name: "Ada" } }),
    );
    expect(response.read).toHaveBeenCalledExactlyOnceWith("json");
  });

  test("recognize Standard Schemas that are functions", async () => {
    const { adapter } = mockTransport();
    const callable = <Output>(output: Output) =>
      Object.assign(() => {}, schema(() => ({ value: output })), { kind: "intersection" });
    const call = c.bind(
      c.endpoint("/users/{id}", {
        method: "POST",
        path: callable({ id: "8" }),
        query: callable({ q: "a" }),
        body: callable({ name: "Ada" }),
        responses: { 200: callable("Grace") },
      }),
      adapter,
    );

    await expect(call({ path: { id: "7" }, query: {}, body: {} })).resolves.toMatchObject({
      body: "Grace",
    });

    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "/users/8?q=a", bodyKind: "json", body: { name: "Ada" } }),
    );
  });
});

describe("call controls", () => {
  test("unchecked overrides the request and still applies response schemas", async () => {
    const { adapter } = mockTransport();
    const validate = vi.fn(() => ({ value: { id: 7 } }));
    const requestSchema = schema(validate);
    const get = c.bind(
      c.endpoint("/users/{id}", {
        path: requestSchema,
        query: requestSchema,
        headers: requestSchema,
        body: requestSchema,
        responses: {
          200: {
            headers: schema(() => ({ value: "checked" })),
            body: schema(() => ({ value: { checked: true } })),
          },
        },
      }),
      adapter,
    );

    const result = await get({
      unchecked: true,
      method: "PATCH",
      path: "https://other.test/broken",
      bodyKind: "text",
      body: "{bad",
    });

    expect(validate).not.toHaveBeenCalled();
    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "PATCH",
        url: "https://other.test/broken",
        bodyKind: "text",
        body: "{bad",
      }),
    );
    expect(result).toMatchObject({ headers: "checked", body: { checked: true } });
  });

  test("an explicitly expected undeclared status returns raw headers", async () => {
    const headers = { "x-request-id": "r1" };
    const { adapter, response } = mockTransport({ status: 418, headers });
    const get = c.bind(c.endpoint("/status"), adapter);

    const result = await get({ status: 418 });

    expect(result).toMatchObject({ status: 418, body: undefined });
    expect(result.headers).toBe(headers);
    expect(response.read).toHaveBeenCalledExactlyOnceWith("none");
  });

  test("discard validates headers and skips the body schema", async () => {
    const { adapter, response } = mockTransport();
    const validateBody = vi.fn(() => ({ value: "unused" }));
    const get = c.bind(
      c.endpoint("/users", {
        responses: {
          200: {
            headers: schema(() => ({ value: { checked: true } })),
            body: schema(validateBody),
          },
        },
      }),
      adapter,
    );

    await expect(get({ discard: true })).resolves.toMatchObject({
      headers: { checked: true },
      body: undefined,
    });

    expect(validateBody).not.toHaveBeenCalled();
    expect(response.read).toHaveBeenCalledExactlyOnceWith("none");
  });
});

describe("URLs", () => {
  test("the written text selects how the base URL applies", async () => {
    const { sent, transport } = recorder();
    const api = c.bind(
      {
        tenant: c.endpoint("/{tenant}/users", { responses: { 204: "none" } }),
        other: c.endpoint("https://other.test/users/{id}", { responses: { 204: "none" } }),
        cdn: c.endpoint("//cdn.test/{file}", { responses: { 204: "none" } }),
      },
      transport,
    );
    await api.tenant({ path: { tenant: "" } });
    await api.other({ path: { id: 1 } });
    await api.cdn({ path: { file: "a" } });
    await api.tenant({ unchecked: true, path: "/raw" });
    await api.tenant({ unchecked: true, path: "//host/x" });
    await api.tenant({ unchecked: true, path: "http://other.test/x" });
    expect(sent.map((item) => item.url)).toEqual([
      "https://api.test/v1//users",
      "https://other.test/users/1",
      "https://cdn.test/a",
      "https://api.test/v1/raw",
      "https://host/x",
      "http://other.test/x",
    ]);

    const noBase: string[] = [];
    const bare = fetchTransport({ fetch: async (url) => (noBase.push(String(url)), new Response(null, { status: 204 })) });
    await c.bind(users, bare).get({ unchecked: true, path: "//host/x" });
    expect(noBase).toEqual(["//host/x"]);
  });
});
