// Type checks without `strictNullChecks`, the default when `strict` is off.
import { expectTypeOf, test } from "vitest";
import {
  c,
  type InferInput,
  type Operation,
  type ResponseKindMap,
  type Transport,
} from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

type User = { id: number; name: string };

const api = c.bind(
  {
    get: c.endpoint("/users/{id}", { responses: { 200: c.json<User>(), 404: c.none() } }),
    create: c.endpoint("/users", {
      method: "POST",
      body: c.json<{ name: string }>(),
      responses: { 201: c.json(), 409: c.text() },
    }),
    post: c.endpoint("/any", { method: "POST", body: c.json(), responses: { 204: c.none() } }),
    health: c.endpoint("/health"),
  },
  fetchTransport(),
);

test("bound endpoints stay callable and narrow by status", async () => {
  const result = await api.get({ path: { id: 1 } });
  expectTypeOf(result.status).toEqualTypeOf<200 | 404>();
  if (result.status === 200) {
    expectTypeOf(result.body).toEqualTypeOf<User>();
  }

  const one = await api.get({ path: { id: 1 }, status: 200 });
  expectTypeOf(one.status).toEqualTypeOf<200>();

  const input = { path: { id: 1 }, status: 404 } as const;
  expectTypeOf((await api.get(input)).status).toEqualTypeOf<404>();

  const discarded = await api.get({ path: { id: 1 }, status: 200, discard: true });
  expectTypeOf(discarded.body).toEqualTypeOf<undefined>();
});

test("required parts stay required and optional parts stay optional", async () => {
  // @ts-expect-error the path parameter is required
  await api.get();
  // @ts-expect-error a typed body is required
  await api.create();
  // @ts-expect-error an endpoint without responses needs a status
  await api.health();

  await api.create({ body: { name: "Ada" } });
  await api.post();
  await api.health({ status: 204 });
  ({ path: { id: 1 } }) satisfies InferInput<typeof api.get>;
});

declare const stringJson: Transport<{ json: string }, ResponseKindMap>;

test("portable operations require compatible body inputs with strictFunctionTypes off", () => {
  const json = c.endpoint("/json", { body: c.json(), responses: { 200: c.json() } });
  // @ts-expect-error portable callers can send a JSON object
  c.bind(json, stringJson) satisfies Operation<typeof json>;
});
