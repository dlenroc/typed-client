import { expectTypeOf, test } from "vitest";
import {
  c,
  type InferInput,
  type InferResponse,
  type Operation,
  type RequestKindMap,
  type ResponseKindMap,
  type Transport,
} from "@dlenroc/typed-client";
import type { APIRequestContext } from "playwright-core";
import { k6Transport } from "@dlenroc/typed-client/k6";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

test("derive portable input and response types from an endpoint", () => {
  const save = c.endpoint("/users/{id}", {
    method: "PUT",
    body: c.json<{ name: string }>(),
    responses: { 200: c.json<{ id: number }>(), 404: c.none() },
  });
  expectTypeOf(save.method).toEqualTypeOf<"PUT">();
  expectTypeOf(c.endpoint("/ping").method).toEqualTypeOf<"GET">();
  expectTypeOf(c.endpoint("/ping", {}).method).toEqualTypeOf<"GET">();
  const input = { path: { id: 7 }, body: { name: "Ada" } } satisfies InferInput<typeof save>;
  void c.bind(save, fetchTransport())(input);
  expectTypeOf<InferInput<typeof save>["body"]>().toEqualTypeOf<{ name: string }>();
  expectTypeOf<"transport" extends keyof InferInput<typeof save> ? true : false>().toEqualTypeOf<false>();
  type Result = InferResponse<typeof save>;
  expectTypeOf<Extract<Result, { status: 200 }>["body"]>().toEqualTypeOf<{ id: number }>();
  expectTypeOf<Extract<Result, { status: 404 }>["body"]>().toEqualTypeOf<undefined>();
  expectTypeOf<"transport" extends keyof Result ? true : false>().toEqualTypeOf<false>();
  const removed = c.endpoint("/users/{id}", { method: "DELETE", responses: { 204: c.none() } });
  type Either = InferResponse<typeof save | typeof removed>;
  expectTypeOf<Either["status"]>().toEqualTypeOf<200 | 204 | 404>();
  expectTypeOf<Extract<Either, { status: 200 }>["body"]>().toEqualTypeOf<{ id: number }>();
  const custom = c.endpoint("/file", { body: c.kind("custom"), responses: { 200: c.kind("custom") } });
  expectTypeOf<InferInput<typeof custom>["body"]>().toEqualTypeOf<unknown>();
  expectTypeOf<InferResponse<typeof custom>["body"]>().toEqualTypeOf<unknown>();
});

type RequestA = { custom: string | number; none: undefined };
type RequestB = { custom: string | boolean; none: undefined };
type Response = { none: undefined };
declare const adapter:
  | Transport<RequestA, Response, { a: string }, { id: number }>
  | Transport<RequestB, Response, { b: string }>;

test("accept only inputs supported by each possible adapter", async () => {
  const op = c.bind(c.endpoint("/x", { body: c.kind("custom"), responses: { 204: c.none() } }), adapter);
  const result = await op({ body: "ok", transport: { a: "a", b: "b" } });
  expectTypeOf(result.transport).toEqualTypeOf<{ id: number } | undefined>();
  // @ts-expect-error the second adapter also needs b
  await op({ body: "ok", transport: { a: "a" } });
  // @ts-expect-error the second adapter cannot send a number
  await op({ body: 1, transport: { a: "a", b: "b" } });
  // @ts-expect-error selecting a raw kind must still work with both adapters
  await op({ body: c.raw(1, "custom"), transport: { a: "a", b: "b" } });
});

declare const jsonOnly: Transport<{ json: unknown }, Response>;
test("raw JSON text requires a transport that can send text", async () => {
  const op = c.bind(c.endpoint("/x", { body: c.json(), responses: { 204: c.none() } }), jsonOnly);
  await op({ body: "value" });
  await op({ body: c.raw("value", "json") });
  await op({ body: c.raw({ a: 1 }) });
  // @ts-expect-error an implicit raw string uses the text encoder
  await op({ body: c.raw("{broken") });
});

test("a numeric index signature cannot guarantee a declared response", async () => {
  const declared = c.text();
  const responses: Record<number, typeof declared> = { 200: declared };
  const ep = c.endpoint("/x", { responses });
  const op = c.bind(ep, fetchTransport());
  expectTypeOf((await op({ status: 404 })).body).toEqualTypeOf<string | undefined>();
  expectTypeOf<InferResponse<typeof ep, 404>["body"]>().toEqualTypeOf<string | undefined>();
});

test("an inferred input has no body when the endpoint forbids one", () => {
  const get = c.bind(c.endpoint("/users", { responses: { 200: c.json() } }), fetchTransport());
  const post = c.bind(c.endpoint("/users", { method: "POST", body: c.json() }), fetchTransport());
  expectTypeOf<"body" extends keyof InferInput<typeof get> ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<InferInput<typeof post>["body"]>().toEqualTypeOf<unknown>();
});

test("forwarded call parameters include undeclared statuses", async () => {
  const get = c.bind(
    c.endpoint("/users/{id}", { responses: { 200: c.json<{ id: number }>(), 404: c.none() } }),
    fetchTransport(),
  );
  expectTypeOf(get).toMatchTypeOf<Operation>();
  const forward = (input: Parameters<typeof get>[0]) => get(input);
  expectTypeOf<418>().toMatchTypeOf<Awaited<ReturnType<typeof forward>>["status"]>();
});

declare const context: APIRequestContext;
declare const traced: Transport<RequestKindMap, ResponseKindMap, { trace: string }>;
declare const narrow: Transport<{ json: string }, ResponseKindMap>;
declare const widerText: Transport<RequestKindMap, { text: string | number; json: string }>;

test("a portable helper accepts operations that can run without native options", async () => {
  const create = c.endpoint("/users", {
    method: "POST", body: c.json<{ name: string }>(),
    responses: { 201: c.json<{ id: number }>(), 409: c.text() },
  });
  async function seed(op: Operation<typeof create>) {
    const r = await op({ body: { name: "Ada" }, status: 201 });
    expectTypeOf(r.body.id).toEqualTypeOf<number>();
    expectTypeOf(r.transport).toEqualTypeOf<object | undefined>();
    expectTypeOf<InferResponse<typeof op>["transport"]>().toEqualTypeOf<object | undefined>();
    const configured = { body: { name: "Ada" }, transport: { trace: "x" } };
    // @ts-expect-error a portable helper cannot supply native options
    await op(configured);
    // @ts-expect-error a stored input cannot carry native options either
    configured satisfies InferInput<typeof op>;
  }

  void seed(c.bind(create, fetchTransport()));
  void seed(c.bind(create, k6Transport()));
  void seed(c.bind(create, playwrightTransport({ context })));
  const specific: Operation<typeof create, typeof traced> = c.bind(create, traced);
  void specific({ body: { name: "Ada" }, transport: { trace: "x" } });
  expectTypeOf(specific).toMatchTypeOf<Operation>();
  // @ts-expect-error the helper has no trace value
  void seed(specific);

  const json = c.endpoint("/json", { body: c.json(), responses: { 200: c.json() } });
  // @ts-expect-error a portable caller can send more than a string
  c.bind(json, narrow) satisfies Operation<typeof json>;
  const statuses = c.endpoint("/status", { responses: { 200: c.text(), 404: c.json() } });
  // @ts-expect-error 200 must return text, even though 404 can return a number
  c.bind(statuses, widerText) satisfies Operation<typeof statuses>;
});
