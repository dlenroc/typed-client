import { describe, expect, test, vi } from "vitest";
import { c, type RequestKindMap, type Transport } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { mockTransport, recorder, schema, users, withToken, type JsonOrNone } from "./fixtures.ts";

describe("calls", () => {
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
          body: c.json(transform("body", { name: "Ada" })),
          responses: {
            200: {
              headers: transform("response headers", { requestId: "r1" }),
              body: c.json(transform("response body", { name: "Grace" })),
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
        transport: undefined,
      });
    },
  );

  test("a schema can supply an omitted query field", async () => {
    const { adapter } = mockTransport();
    const validate = vi.fn(() => ({ value: "/api/cases/42" }));
    const get = c.bind(
      c.endpoint("/index.php", {
        query: schema(validate),
        responses: { 200: c.json() },
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
        responses: { 200: c.json() },
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
    const get = c.bind(c.endpoint(template, { responses: { 200: c.json() } }), adapter);

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
            body: c.json(),
            meta,
            responses: { 200: c.json() },
          }),
        },
      },
      adapter,
    );
    const input = Object.freeze({
      body: { name: "Ada" },
      headers: { accept: "*/*" },
      transport: { trace: "r1" },
    });

    await api.users.create(input);

    expect(adapter).toHaveBeenCalledTimes(1);
    const [sent] = adapter.mock.calls[0]!;
    expect(sent.body).toBe(input.body);
    expect(sent.headers).toBe(input.headers);
    expect(sent.options).toBe(input.transport);
    expect(sent.endpoint.meta).toBe(meta);
  });

});

describe("raw parts and call options", () => {
  test("raw parts skip their request schemas and responses stay checked", async () => {
    const { adapter } = mockTransport();
    const validate = vi.fn(() => ({ value: { id: 7 } }));
    const requestSchema = schema(validate);
    const get = c.bind(
      c.endpoint("/users/{id}", {
        path: requestSchema,
        query: requestSchema,
        headers: requestSchema,
        body: c.json(requestSchema),
        responses: {
          200: {
            headers: schema(() => ({ value: "checked" })),
            body: c.json(schema(() => ({ value: { checked: true } }))),
          },
        },
      }),
      adapter,
    );

    const result = await get({
      method: c.raw("PATCH"),
      path: c.raw("https://other.test/broken"),
      query: c.raw(undefined),
      headers: c.raw({}),
      body: c.raw("{bad", "text"),
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

  test("a raw string for a JSON body is sent as the JSON text", async () => {
    const { sent, transport } = recorder();
    const post = c.bind(
      c.endpoint("/users", { method: "POST", body: c.json(), responses: { 204: c.none() } }),
      transport,
    );
    const headers = { accept: "application/json" };

    await post({ body: c.raw("{broken") });
    await post({ body: c.raw("{broken"), headers });
    await post({ body: c.raw("{broken"), headers: { "Content-Type": "text/csv" } });
    await post({ body: c.raw("{broken"), headers: { "content-type": null } });
    await post({ body: c.raw({ name: "Ada" }) });

    expect(sent.map((item) => [item.init.body, item.headers])).toEqual([
      ["{broken", { "content-type": "application/json" }],
      ["{broken", { accept: "application/json", "content-type": "application/json" }],
      ["{broken", { "Content-Type": "text/csv" }],
      // Fetch sends bytes to leave out its default Content-Type.
      [new TextEncoder().encode("{broken"), {}],
      ['{"name":"Ada"}', { "content-type": "application/json" }],
    ]);
    expect(headers).toEqual({ accept: "application/json" });
  });

  test("a raw JSON string reaches the transport as text", async () => {
    const { adapter } = mockTransport();
    const post = c.bind(
      c.endpoint("/users", { method: "POST", body: c.json(), responses: { 200: c.json() } }),
      adapter,
    );

    await post({ body: c.raw("[1]") });

    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        bodyKind: "text",
        body: "[1]",
        headers: { "content-type": "application/json" },
      }),
    );
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
            body: c.json(schema(validateBody)),
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

describe("URLs, decorators, and the transport request", () => {
  test("the written text selects how the base URL applies", async () => {
    const { sent, transport } = recorder();
    const api = c.bind(
      {
        tenant: c.endpoint("/{tenant}/users", { responses: { 204: c.none() } }),
        other: c.endpoint("https://other.test/users/{id}", { responses: { 204: c.none() } }),
        cdn: c.endpoint("//cdn.test/{file}", { responses: { 204: c.none() } }),
      },
      transport,
    );
    await api.tenant({ path: { tenant: "" } });
    await api.other({ path: { id: 1 } });
    await api.cdn({ path: { file: "a" } });
    await api.tenant({ path: c.raw("/raw") });
    await api.tenant({ path: c.raw("//host/x") });
    await api.tenant({ path: c.raw("http://other.test/x") });
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
    await c.bind(users, bare).get({ path: c.raw("//host/x") });
    expect(noBase).toEqual(["//host/x"]);
  });

  test("a decorator that spreads its headers first lets the caller win", async () => {
    const { sent, transport } = recorder();
    const ada = c.bind(users, withToken(transport, async () => "ada"));
    const path = { id: 1 };
    await ada.get({ path });
    await ada.get({ path, headers: { authorization: "Bearer wrong" } });
    await ada.get({ path, headers: { Authorization: "Bearer wrong" } });
    await ada.get({ path, headers: { authorization: null } });
    await ada.get({ path, headers: { Authorization: null } });
    await ada.get({ path, headers: { authorization: undefined, "x-a": 1 } });
    expect(sent.map((item) => item.headers)).toEqual([
      { authorization: "Bearer ada" },
      { authorization: "Bearer wrong" },
      { Authorization: "Bearer wrong" },
      {},
      {},
      { authorization: "Bearer ada", "x-a": "1" },
    ]);
  });

  test("the transport gets prepared options and no call object", async () => {
    const seen: unknown[] = [];
    const mock: Transport<RequestKindMap, JsonOrNone, { trace?: string }> = async (request) => {
      seen.push(request);
      return { status: 204, url: request.url, headers: {}, read: async () => undefined as never };
    };
    const options = { trace: "t1" };
    await c.bind(users, mock).get({ path: { id: 1 }, timeout: 50, follow: true, discard: true, transport: options });
    expect(seen[0]).toEqual({
      endpoint: users.get,
      method: "GET",
      url: "/users/1",
      reference: "path",
      headers: undefined,
      bodyKind: "none",
      body: undefined,
      discard: true,
      timeout: 50,
      follow: true,
      status: undefined,
      options,
    });
    expect((seen[0] as { options: unknown }).options).toBe(options);
  });

  test("synchronous request schemas all run before the call yields", async () => {
    const seen: string[] = [];
    const pass = <Value>(part: string) =>
      schema((value: unknown) => (seen.push(part), { value: value as Value }));
    const endpoint = c.endpoint("/users/{id}", {
      method: "POST",
      path: pass<{ id: number }>("path"),
      query: pass<Record<string, string>>("query"),
      headers: pass<Record<string, string>>("headers"),
      body: c.json(pass<{ name: string }>("body")),
      responses: { 204: c.none() },
    });
    const { transport } = recorder();
    const pending = c.bind(endpoint, transport)({
      path: { id: 1 },
      query: {},
      headers: {},
      body: { name: "Ada" },
    });
    expect(seen).toEqual(["path", "query", "headers", "body"]);
    await pending;
  });

  test("a raw path parameter without a value is missing", async () => {
    const { transport } = recorder();
    await expect(c.bind(users, transport).get({ path: { id: c.raw(undefined as never) } })).rejects.toMatchObject({
      code: "request",
    });
  });
});
