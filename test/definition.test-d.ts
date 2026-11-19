import { c } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { describe, expectTypeOf, test } from "vitest";

declare const flag: boolean;

test("record fields can accept either one value or repeated values", async () => {
  interface Filters { tag: string | readonly string[] }
  const get = c.bind(c.endpoint("/", {
    query: c.type<Filters>(),
    responses: { 200: c.none() },
  }), fetchTransport());
  await get({ query: { tag: "a" } });
  await get({ query: { tag: ["a", "b"] } });
  c.endpoint("/", { body: c.urlencoded<Filters>() });
  c.endpoint("/", { body: c.multipart<Filters>() });
  // @ts-expect-error Every array element must be a wire scalar
  c.endpoint("/", { query: c.type<{ tag: string | Date[] }>() });
});

test("conditionally present declarations must be narrowed before use", () => {
  // @ts-expect-error The runtime endpoint may require a body
  c.endpoint("/", { method: "POST", ...(flag && { body: c.json<{ id: number }>() }) });
  // @ts-expect-error The runtime endpoint may validate the query
  c.endpoint("/", { ...(flag && { query: c.type<{ id: number }>() }) });
  // @ts-expect-error A missing responses map changes accepted statuses
  c.endpoint("/", { ...(flag && { responses: { 200: c.text() } }) });
  // @ts-expect-error A missing status changes its response type
  c.endpoint("/", { responses: { 204: c.none(), ...(flag && { 200: c.text() }) } });
  // @ts-expect-error A missing response body changes its decoded value
  c.endpoint("/", { responses: { 200: { ...(flag && { body: c.text() }) } } });
  const ok = { responses: { 200: c.text() } };
  const missing = { responses: { 404: c.json<{ message: string }>() } };
  // @ts-expect-error Each branch has a different set of statuses
  c.endpoint("/", flag ? ok : missing);

  // Narrow before declaring the endpoint, or choose a kind for a stable status.
  const transport = fetchTransport();
  const result = flag ? c.bind(c.endpoint("/", ok), transport)() : c.bind(c.endpoint("/", missing), transport)();
  expectTypeOf<Awaited<typeof result>["status"]>().toEqualTypeOf<200 | 404>();
  const varied = c.bind(c.endpoint("/", { responses: { 200: flag ? c.text() : c.binary() } }), transport);
  expectTypeOf<Awaited<ReturnType<typeof varied>>["body"]>().toMatchTypeOf<string | Uint8Array | undefined>();
});

describe("endpoint declarations", () => {
  test("name the reason when a declaration cannot work", () => {
    // @ts-expect-error the path schema output needs each template parameter
    c.endpoint("/users/{id}", { path: c.type<{ uid: string }>() });
    // @ts-expect-error a status key must be a number
    c.endpoint("/users", { responses: { "4XX": c.json() } });
    // @ts-expect-error response header names are lowercase
    c.endpoint("/users", { responses: { 200: { headers: c.type<{ "X-Request-Id": string }>() } } });
    // @ts-expect-error a body is declared with a kind helper
    c.endpoint("/users", { method: "POST", body: "json" });

    c.endpoint("/users", { responses: { "200": c.json(), 204: { headers: c.type<{ etag: string }>() } } });
  });

  test("report unknown keys next to valid keys", () => {
    // @ts-expect-error `reponses` is not a key of a definition
    c.endpoint("/users", { method: "POST", body: c.json(), reponses: { 201: c.none() } });
    // @ts-expect-error `heders` is not a key of a response descriptor
    c.endpoint("/users", { responses: { 200: { body: c.json(), heders: c.type<{ etag: string }>() } } });

    const definition = { method: "POST", note: "kept", responses: { 201: c.none() } };
    c.endpoint("/users", definition);
  });

  test("give a kind helper a type argument", async () => {
    const send = c.bind(
      c.endpoint("/form", {
        method: "POST",
        body: c.urlencoded<{ page: number }>(),
        responses: { 200: c.text<"ok">(), 201: c.urlencoded<{ token: string }>() },
      }),
      fetchTransport(),
    );
    expectTypeOf((await send({ body: { page: 1 }, status: 200 })).body).toEqualTypeOf<"ok">();
    expectTypeOf((await send({ body: { page: 1 }, status: 201 })).body.token).toEqualTypeOf<string>();

    // @ts-expect-error a text body type is a string
    c.text<number>();
    // @ts-expect-error a URL-encoded response has string values
    c.endpoint("/form", { responses: { 200: c.urlencoded<{ page: number }>() } });
  });

  test("keep kinds when a definition is declared before the call", async () => {
    const definition = { method: "POST", body: c.json<{ name: string }>(), responses: { 201: c.text() } };
    const create = c.bind(c.endpoint("/users", definition), fetchTransport());
    expectTypeOf((await create({ body: { name: "Ada" } })).body).toEqualTypeOf<string>();
  });
});

test("an endpoint keeps the type of its meta", () => {
  const endpoint = c.endpoint("/users", { meta: { operationId: "getUser" } });
  expectTypeOf(endpoint.meta.operationId).toEqualTypeOf<"getUser">();
});
