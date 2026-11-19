import { describe, expectTypeOf, test } from "vitest";
import {
  c,
  ClientError,
  type InferInput,
  type InferResponse,
  type ResponseHeaders,
} from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

declare const flag: boolean;
declare const status: { status?: 418 };
declare const discard: { discard?: boolean };
declare const maybeExpectation: { status: 418; discard: true } | undefined;

describe("bound calls", () => {
  const api = c.bind(
    {
      getUser: c.endpoint("/users/{id}", {
        responses: {
          200: { body: c.json<{ id: number }>(), headers: c.type<{ "x-team": string }>() },
          404: c.none(),
        },
      }),
      health: c.endpoint("/health"),
      post: c.endpoint("/users", { method: "POST", body: c.json(), responses: { 201: c.none() } }),
    },
    fetchTransport(),
  );

  test("infer request fixtures and retain status and response metadata", async () => {
    const input = { path: { id: 7 }, status: 200, transport: { cache: "no-store" } } satisfies InferInput<typeof api.getUser>;

    const result = await api.getUser(input);

    expectTypeOf(result).toEqualTypeOf<InferResponse<typeof api.getUser, 200>>();
    expectTypeOf(result.body).toEqualTypeOf<{ id: number }>();
    expectTypeOf(result.headers["x-team"]).toEqualTypeOf<string>();
    expectTypeOf(result.headers["content-type"]).toEqualTypeOf<string | undefined>();
    expectTypeOf(result.transport.redirected).toEqualTypeOf<boolean>();

    // @ts-expect-error an inferred input requires the path parameter
    ({ status: 200 }) satisfies InferInput<typeof api.getUser>;
    // @ts-expect-error Fetch cache options are checked
    await api.getUser({ path: { id: 7 }, transport: { cache: "bad" } });
  });

  test("infer path parameters inside segments", () => {
    const job = c.bind(
      c.endpoint("/jobs/{id}:cancel/{file}.json?x={y}", { responses: { 204: c.none() } }),
      fetchTransport(),
    );
    ({ path: { id: 1, file: "a" } }) satisfies InferInput<typeof job>;
    // @ts-expect-error each `{name}` in the path is required
    ({ path: { id: 1 } }) satisfies InferInput<typeof job>;
    // @ts-expect-error `{name}` in the query is literal text
    ({ path: { id: 1, file: "a", y: 2 } }) satisfies InferInput<typeof job>;

    const literal = c.bind(
      c.endpoint("/users/:id/{}", { responses: { 204: c.none() } }),
      fetchTransport(),
    );
    void literal();
  });

  test("narrow bodies by declared and explicitly accepted statuses", async () => {
    const result = await api.getUser({ path: { id: 7 } });
    expectTypeOf(result).toEqualTypeOf<InferResponse<typeof api.getUser>>();
    expectTypeOf(result.status).toEqualTypeOf<200 | 404>();

    const mixed = await api.getUser({ path: { id: 7 }, status: [200, 418] });
    expectTypeOf(mixed).toEqualTypeOf<InferResponse<typeof api.getUser, 200 | 418>>();
    expectTypeOf(mixed.status).toEqualTypeOf<200 | 418>();

    if (mixed.status === 418) {
      expectTypeOf(mixed.body).toEqualTypeOf<undefined>();
      expectTypeOf(mixed.headers).toEqualTypeOf<ResponseHeaders>();
    } else {
      expectTypeOf(mixed.body).toEqualTypeOf<{ id: number }>();
    }
  });

  test("require a status for status-only endpoints and reject empty expectations", async () => {
    const result = await api.health({ status: 204 });
    expectTypeOf(result).toEqualTypeOf<InferResponse<typeof api.health, 204>>();
    expectTypeOf(result.status).toEqualTypeOf<204>();
    expectTypeOf(result.body).toEqualTypeOf<undefined>();

    // @ts-expect-error status-only calls require a status
    await api.health();
    // @ts-expect-error a raw part still requires a status
    await api.health({ path: c.raw("/x") });
    // @ts-expect-error status-only input fixtures also require a status
    ({}) satisfies InferInput<typeof api.health>;
    // @ts-expect-error a literal empty list cannot accept any status
    await api.getUser({ path: { id: 7 }, status: [] });
    // @ts-expect-error a status-only call rejects a literal empty list
    await api.health({ status: [] });
  });

  test("permit malformed parts only with a raw value", async () => {
    const malformed = await api.getUser({
      path: c.raw("/broken"),
      body: c.raw("{bad", "text"),
      status: [200, 422],
      discard: true,
      transport: { cache: "no-store" },
    });
    expectTypeOf(malformed.status).toEqualTypeOf<200 | 422>();
    expectTypeOf(malformed.body).toEqualTypeOf<undefined>();

    // One raw parameter. The other fields stay checked.
    const one = await api.getUser({ path: { id: c.raw("a/b") }, status: 200 });
    expectTypeOf(one.body).toEqualTypeOf<{ id: number }>();
    await api.getUser({ path: { id: 7 }, query: c.raw("a=%ZZ"), method: c.raw("PATCH") });
    await api.getUser({ path: { id: 7 }, headers: c.raw({ "content-length": "9" }) });

    // @ts-expect-error a raw part does not remove the required path
    await api.getUser({ body: c.raw("{bad", "text") });
    // @ts-expect-error a path parameter needs a scalar value
    await api.getUser({ path: { id: new Date() } });
    // @ts-expect-error a path string must be raw
    await api.getUser({ path: "/broken" });
    // @ts-expect-error a method must be raw
    await api.getUser({ path: { id: 7 }, method: "PATCH" });
    // @ts-expect-error a raw body with a kind must match the kind of the transport
    await api.getUser({ path: { id: 7 }, body: c.raw(7, "text") });
    // @ts-expect-error the transport has no such kind
    await api.getUser({ path: { id: 7 }, body: c.raw("x", "xml") });
    // @ts-expect-error a raw query is a string or a query record
    await api.getUser({ path: { id: 7 }, query: c.raw(5) });
    // @ts-expect-error a raw path parameter is a string
    await api.getUser({ path: { id: c.raw(5) } });
    const id = c.raw("a/b");
    await api.getUser({ path: { id } });
    await api.getUser({ path: id });
    const stored = c.raw("{bad", "text");
    await api.getUser({ path: { id: 7 }, body: stored });
    // @ts-expect-error a raw path is a string
    await api.getUser({ path: c.raw(7) });
    // @ts-expect-error other fields stay checked next to a raw part
    await api.getUser({ path: c.raw("/broken"), query: 7 });
  });

  test("report unknown keys at every depth of an inline call, like a declared parameter", async () => {
    const create = c.bind(
      c.endpoint("/users/{id}", {
        method: "POST",
        query: c.type<{ page?: number }>(),
        headers: c.type<{ "x-a"?: string }>(),
        body: c.json<{ name: string; tags?: { key: string }[] }>(),
        responses: { 204: c.none() },
      }),
      fetchTransport(),
    );
    const body = { name: "Ada" };

    // @ts-expect-error a path key that the template does not have
    await create({ path: { id: 1, extra: 2 }, body });
    // @ts-expect-error a misspelled query key next to a valid one
    await create({ path: { id: 1 }, query: { page: 1, pgae: 2 }, body });
    // @ts-expect-error a header key that the declaration does not have
    await create({ path: { id: 1 }, headers: { "x-a": "1", "x-b": "2" }, body });
    // @ts-expect-error a misspelled body key next to a valid one
    await create({ path: { id: 1 }, body: { name: "Ada", nmae: "x" } });
    // @ts-expect-error an unknown key in a nested body array
    await create({ path: { id: 1 }, body: { name: "Ada", tags: [{ key: "a", value: "b" }] } });
    // @ts-expect-error a misspelled call option
    await create({ path: { id: 1 }, body, timout: 5 });
    // @ts-expect-error a misspelled transport option
    await create({ path: { id: 1 }, body, transport: { cache: "no-store", cahce: "x" } });

    // A variable is not an object literal, so extra keys are allowed, as for any function.
    const wide = { path: { id: 1 }, body: { name: "Ada", extra: 1 } };
    await create(wide);
    await create({ path: { id: 1 }, body, headers: { "x-a": "1" }, ...(flag ? { timeout: 5 } : {}) });
  });

  test("accept the same optional JSON values in calls and inferred inputs", async () => {
    interface User {
      name: string;
    }
    const user: User = { name: "Ada" };
    const input = { body: user } satisfies InferInput<typeof api.post>;

    await api.post();
    await api.post({ body: null });
    await api.post(input);
    await api.post({ body: { id: 1n } });
  });

  test("preserve all possible responses for optional controls", async () => {
    const result = await api.getUser({ path: { id: 7 }, ...status, ...discard });
    expectTypeOf(result.status).toEqualTypeOf<200 | 404 | 418>();
    expectTypeOf(result.body).toEqualTypeOf<{ id: number } | undefined>();

    const discarded = await api.getUser({ path: { id: 7 }, status: 200, discard: true });
    expectTypeOf(discarded.body).toEqualTypeOf<undefined>();
  });
});

test("require inputs valid for every possible request kind", async () => {
  const body = flag ? c.json() : c.none();
  const send = c.bind(
    c.endpoint("/data", {
      method: "POST",
      body,
      responses: { 204: c.none() },
    }),
    fetchTransport(),
  );

  await send();
  // @ts-expect-error the chosen kind may forbid a body
  await send({ body: { id: 7 } });
  await send({ body: c.raw({ id: 7 }, "json") });
});

test("narrow ClientError diagnostics by code", (error?: unknown) => {
  if (!(error instanceof ClientError)) {
    return;
  }

  if (error.code === "status") {
    expectTypeOf(error.status).toEqualTypeOf<number>();
    expectTypeOf(error.schema).toEqualTypeOf<undefined>();
    expectTypeOf(error.issues).toEqualTypeOf<undefined>();
    expectTypeOf(error.headers).toEqualTypeOf<ResponseHeaders>();
    expectTypeOf(error.body).toEqualTypeOf<string | undefined>();
  }
  if (error.code === "request") {
    expectTypeOf(error.status).toEqualTypeOf<undefined>();
    expectTypeOf(error.headers).toEqualTypeOf<undefined>();
    expectTypeOf(error.body).toEqualTypeOf<undefined>();
    expectTypeOf(error.schema).toEqualTypeOf<"path" | "query" | "headers" | "body" | undefined>();
    expectTypeOf(error.issues?.[0]?.message).toEqualTypeOf<string | undefined>();
  }
  if (error.code === "transport") {
    expectTypeOf(error.status).toEqualTypeOf<number | undefined>();
    expectTypeOf(error.headers).toEqualTypeOf<undefined>();
  }
  if (error.code === "timeout") {
    expectTypeOf(error.status).toEqualTypeOf<number | undefined>();
    expectTypeOf(error.body).toEqualTypeOf<undefined>();
  }
  if (error.code === "response") {
    expectTypeOf(error.status).toEqualTypeOf<number>();
    expectTypeOf(error.schema).toEqualTypeOf<"headers" | "body" | undefined>();
    expectTypeOf(error.headers).toEqualTypeOf<ResponseHeaders>();
    expectTypeOf(error.body).toEqualTypeOf<unknown>();
  }
});

test("a body is part of the contract", () => {
  const bound = c.bind(
    {
      ping: c.endpoint("/ping", { method: "POST", responses: { 204: c.none() } }),
      save: c.endpoint("/save", { method: "POST", body: c.json(), responses: { 204: c.none() } }),
    },
    fetchTransport(),
  );
  // @ts-expect-error the endpoint declares no body
  void bound.ping({ body: { x: 1 } });
  void bound.ping({ body: c.raw({ x: 1 }, "json") });
  void bound.save({ body: { x: 1 } });
});

test("a type hint with only optional keys makes its part optional", () => {
  const bound = c.bind(
    {
      list: c.endpoint("/list", { query: c.type<{ page?: number }>(), headers: c.type<{ "x-trace"?: string }>() }),
      find: c.endpoint("/find", { query: c.type<{ q: string }>() }),
    },
    fetchTransport(),
  );
  void bound.list({ status: 200 });
  void bound.list({ query: { page: 2 }, status: 200 });
  // @ts-expect-error the query has a required key
  void bound.find({ status: 200 });
});

test("a typed field keeps its declared type", async () => {
  type Page = { page?: number };
  type Auth = { authorization?: string | undefined };
  const list = c.bind(
    c.endpoint("/users", { query: c.type<Page>(), headers: c.type<Auth>() }),
    fetchTransport(),
  );
  const token = undefined as string | undefined;
  const page = undefined as number | undefined;
  await list({ headers: { authorization: token }, status: 200 });
  // @ts-expect-error the declared type has no `undefined` for `page`
  await list({ query: { page }, status: 200 });
});

test("optional arguments include every possible response", async () => {
  const get = c.bind(c.endpoint("/", { responses: { 200: c.text() } }), fetchTransport());
  expectTypeOf((await get()).body).toEqualTypeOf<string>();
  expectTypeOf((await get(undefined)).status).toEqualTypeOf<200>();
  expectTypeOf((await get({})).status).toEqualTypeOf<200>();
  // @ts-expect-error explicit type arguments cannot promise a different status
  get<[{ status: 418 }]>({ status: 200 });
  const maybe = await get(maybeExpectation);
  expectTypeOf(maybe.status).toEqualTypeOf<200 | 418>();
  expectTypeOf(maybe.body).toEqualTypeOf<string | undefined>();
});
