import { describe, expect, test } from "vitest";
import { c } from "@dlenroc/typed-client";
import { mockTransport, recorder, schema } from "./fixtures.ts";

describe("c.endpoint", () => {
  test("the endpoint is frozen normalized data and meta stays the caller's object", () => {
    const meta = { operationId: "getUser" };
    const endpoint = c.endpoint("/users/{id}", { responses: { 200: c.json() }, meta });
    expect(endpoint).toEqual({
      method: "GET",
      template: "/users/{id}",
      params: ["id"],
      request: { path: undefined, query: undefined, headers: undefined, body: { kind: "none", schema: undefined } },
      responses: { 200: { headers: undefined, body: { kind: "json", schema: undefined } } },
      meta,
    });
    expect(endpoint.meta).toBe(meta);
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(Object.isFrozen(endpoint.request.body)).toBe(true);
    expect(Object.isFrozen(endpoint.responses[200])).toBe(true);
    expect(Object.isFrozen(endpoint.params)).toBe(true);
    expect(Object.isFrozen(meta)).toBe(false);
  });

  test("an endpoint keeps body declarations by reference", () => {
    const body = c.json<{ name: string }>();
    const headers = schema(() => ({ value: {} }));
    const endpoint = c.endpoint("/users", {
      method: "POST",
      body,
      responses: { 201: body, 204: { headers }, 409: c.text() },
    });
    expect(endpoint.request.body).toBe(body);
    expect(endpoint.responses[201]!.body).toBe(body);
    expect(endpoint.responses[204]).toEqual({ headers, body: { kind: "none", schema: undefined } });
    expect(endpoint.responses[409]!.body).toEqual({ kind: "text", schema: undefined });
    expect(c.kind("blob", headers)).toEqual({ kind: "blob", schema: headers });
    expect(c.none()).toBe(c.none());
  });

  test("a plain object is an endpoint", async () => {
    const { sent, transport } = recorder();
    const plain = {
      method: "GET",
      template: "/users/{id}",
      params: ["id"],
      request: { path: undefined, query: undefined, headers: undefined, body: { kind: "none", schema: undefined } },
      responses: { 204: { headers: undefined, body: { kind: "none", schema: undefined } } },
      meta: {},
    } as const;
    await c.bind(plain, transport)({ path: { id: 7 } });
    expect(sent[0]!.url).toBe("https://api.test/v1/users/7");
  });

  test("recognize schemas with their own body and kind fields", async () => {
    const { adapter, response } = mockTransport();
    const parse = { ...schema(() => ({ value: { name: "Ada" } })), kind: "text" as const };
    const decode = { ...schema(() => ({ value: "Ada" })), body: "none" as const };
    const call = c.bind(
      c.endpoint("/users", {
        method: "POST",
        body: c.json(parse),
        responses: { 200: c.json(decode) },
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
        body: c.json(callable({ name: "Ada" })),
        responses: { 200: c.json(callable("Grace")) },
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
