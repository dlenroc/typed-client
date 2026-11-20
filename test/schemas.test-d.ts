// Schemas transform each part: a call takes the input type, and a response
// gives the output type, per status.
import { describe, expectTypeOf, test } from "vitest";
import { c, type InferInput, type JsonValue, type ResponseHeaders } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

// A Standard Schema that maps `Input` to `Output`.
declare function transform<Input, Output>(): {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "test";
    readonly validate: (value: unknown) => { readonly value: Output };
    readonly types: { readonly input: Input; readonly output: Output };
  };
};

declare const flag: boolean;

describe("request schemas", () => {
  const create = c.bind(
    c.endpoint("/events/{id}", {
      method: "POST",
      path: transform<{ id: string }, { id: number }>(),
      query: transform<{ since: Date }, { since: string }>(),
      headers: transform<{ token: string }, { authorization: string }>(),
      body: c.json(transform<{ at: Date }, { at: string }>()),
      responses: { 201: c.none() },
    }),
    fetchTransport(),
  );

  test("a call takes the schema input of each part", async () => {
    expectTypeOf<InferInput<typeof create>["path"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<InferInput<typeof create>["query"]>().toEqualTypeOf<{ since: Date }>();
    expectTypeOf<InferInput<typeof create>["headers"]>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<InferInput<typeof create>["body"]>().toEqualTypeOf<{ at: Date }>();

    const input = { headers: { token: "t" }, query: { since: new Date() } };
    await create({ ...input, path: { id: "7" }, body: { at: new Date() } });
    await create({ ...input, path: { id: "7" }, body: c.raw({ at: "2020" }) });
    // @ts-expect-error the path schema input is a string
    await create({ ...input, path: { id: 7 }, body: { at: new Date() } });
    // @ts-expect-error the body schema input is a Date
    await create({ ...input, path: { id: "7" }, body: { at: "2020" } });
    // @ts-expect-error the headers schema input has `token`, not the output key
    await create({ ...input, headers: { authorization: "x" }, path: { id: "7" }, body: { at: new Date() } });
  });

  test("a runtime choice of schema needs an input both schemas accept", async () => {
    type Name = { name: string };
    type Email = { email: string };
    type Wire = { id: string };
    const chosen = flag ? transform<Name, Wire>() : transform<Email, Wire>();
    const endpoint = c.endpoint("/users/{id}", {
      method: "POST", path: chosen, query: chosen, headers: chosen, body: c.json(chosen),
      responses: { 204: c.none() },
    });
    const call = c.bind(endpoint, fetchTransport());
    const both = { name: "Ada", email: "ada@example.test" };
    const name = { name: "Ada" };
    const input = { path: both, query: both, headers: both, body: both } satisfies InferInput<typeof endpoint>;

    await call(input);
    // @ts-expect-error the other path schema requires email
    await call({ ...input, path: name });
    // @ts-expect-error inferred bound inputs must work with either query schema
    ({ ...input, query: name }) satisfies InferInput<typeof call>;
    // @ts-expect-error the other headers schema requires email
    await call({ ...input, headers: name });
    // @ts-expect-error the other body schema requires email
    await call({ ...input, body: name });

    const optionalOrRequired = flag ? transform<Name | undefined, Wire>() : transform<Email, Wire>();
    const lookup = c.bind(c.endpoint("/users", { query: optionalOrRequired, responses: { 204: c.none() } }), fetchTransport());
    // @ts-expect-error one schema requires a query
    await lookup();

    const acceptsEither = transform<Name | Email, Wire>();
    const list = c.bind(c.endpoint("/users", { query: acceptsEither, responses: { 204: c.none() } }), fetchTransport());
    await list({ query: name });
    await list({ query: { email: both.email } });
  });

  test("a schema output must fit the wire value of its part", () => {
    // @ts-expect-error the path output needs `id`
    c.endpoint("/users/{id}", { path: transform<unknown, { uid: string }>() });
    // @ts-expect-error a path value must be a scalar
    c.endpoint("/users/{id}", { path: transform<unknown, { id: Date }>() });
    // @ts-expect-error a query value must be a scalar
    c.endpoint("/users", { query: transform<unknown, { since: Date }>() });
    // @ts-expect-error a header value must be a scalar
    c.endpoint("/users", { headers: transform<unknown, { tags: string[] }>() });
    // @ts-expect-error a text body schema must output a string
    c.endpoint("/users", { method: "POST", body: c.text(transform<{ a: 1 }, number>()) });

    c.endpoint("/users", { query: transform<{ a: string }, string>() });
    c.endpoint("/users", { method: "POST", body: c.text(transform<{ a: 1 }, string>()) });
    c.endpoint("/users", { method: "POST", body: c.urlencoded(transform<unknown, { a: number }>()) });
  });
});

describe("response schemas", () => {
  const get = c.bind(
    c.endpoint("/users/{id}", {
      responses: {
        200: {
          body: c.json(transform<unknown, { at: Date }>()),
          headers: transform<{ "x-total": string }, { total: number }>(),
        },
        302: { headers: transform<{ location: string }, { location: URL }>() },
        404: c.json<{ message: string }>(),
        418: c.text(transform<string, number>()),
      },
    }),
    fetchTransport(),
  );

  test("each status gives its own body and headers output", async () => {
    const result = await get({ path: { id: 1 } });

    if (result.status === 200) {
      expectTypeOf(result.body).toEqualTypeOf<{ at: Date }>();
      expectTypeOf(result.headers).toEqualTypeOf<{ total: number }>();
    } else if (result.status === 302) {
      expectTypeOf(result.body).toEqualTypeOf<undefined>();
      expectTypeOf(result.headers).toEqualTypeOf<{ location: URL }>();
    } else if (result.status === 404) {
      expectTypeOf(result.body).toEqualTypeOf<{ message: string }>();
      expectTypeOf(result.headers).toEqualTypeOf<ResponseHeaders>();
    } else {
      expectTypeOf(result.body).toEqualTypeOf<number>();
    }
  });

  test("a response schema input must accept the decoded value", () => {
    // @ts-expect-error a text body decodes to a string
    c.endpoint("/x", { responses: { 200: c.text(transform<number, number>()) } });
    // @ts-expect-error a binary body decodes to bytes
    c.endpoint("/x", { responses: { 200: c.binary(transform<string, string>()) } });
    // @ts-expect-error header values are strings
    c.endpoint("/x", { responses: { 200: { headers: transform<{ "x-n": number }, unknown>() } } });

    c.endpoint("/x", { responses: { 200: c.text(transform<string | number, number>()) } });
  });
});

test("a handwritten Standard Schema infers the validator's success value", async () => {
  const schema = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      async validate(value: unknown) {
        return typeof value === "string"
          ? { value: value.length }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
  const get = c.bind(c.endpoint("/", { responses: { 200: c.text(schema) } }), fetchTransport());

  expectTypeOf((await get()).body).toEqualTypeOf<number>();
});

test("infer recursive JSON request and response types", async () => {
  interface Category {
    name: string;
    children: Category[];
  }

  const save = c.bind(
    c.endpoint("/categories", {
      method: "POST",
      body: c.json<Category>(),
      responses: { 200: c.json<Category>() },
    }),
    fetchTransport(),
  );

  const result = await save({ body: { name: "Root", children: [] } });

  expectTypeOf<InferInput<typeof save>["body"]>().toEqualTypeOf<Category>();
  expectTypeOf(result.body).toEqualTypeOf<Category>();
  // @ts-expect-error the declared body still requires children
  await save({ body: { name: "Root" } });
});

test("check built-in schema kinds at declaration and native kinds at bind", async () => {
  c.endpoint("/text", {
    // @ts-expect-error text request schemas must produce strings
    body: c.text(c.type<number>()),
  });

  const invalid = c.endpoint("/download", {
    responses: { 200: c.kind("blob", c.type<string>()) },
  });
  // @ts-expect-error Fetch decodes blob as Blob
  c.bind(invalid, fetchTransport());

  const stream = c.endpoint("/download", {
    responses: { 200: c.kind("stream", transform<string, { id: number }>()) },
  });
  // @ts-expect-error Fetch supplies a stream and this schema expects a string
  c.bind(stream, fetchTransport());
});

test("check multipart file data when declaring the endpoint", () => {
  c.endpoint("/files", {
    body: c.multipart(c.type<{ file: { data: Uint8Array } }>()),
  });

  c.endpoint("/files", {
    // @ts-expect-error a portable file descriptor needs binary data
    body: c.multipart(c.type<{ file: { data: number } }>()),
  });
});

test("binary responses are ArrayBuffer-backed bytes for web APIs", async () => {
  const download = c.bind(
    c.endpoint("/file", { responses: { 200: c.binary(), 207: c.multipart() } }),
    fetchTransport(),
  );
  const result = await download();

  if (result.status === 200) {
    expectTypeOf(result.body).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
    void new Blob([result.body]);
    void crypto.subtle.digest("SHA-256", result.body);
  }

  c.endpoint("/file", { responses: { 200: c.binary(c.type<Uint8Array>()) } });
});

test("untyped JSON responses infer JsonValue", async () => {
  const list = c.bind(c.endpoint("/users", { responses: { 200: c.json() } }), fetchTransport());

  expectTypeOf((await list()).body).toEqualTypeOf<JsonValue>();
});
