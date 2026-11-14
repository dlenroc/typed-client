import { describe, expectTypeOf, test } from "vitest";
import {
  c,
  ClientError,
  type InferInput,
  type InferResponse,
  type RequestKindMap,
  type ResponseHeaders,
  type ResponseKindMap,
  type Transport,
} from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

declare const flag: boolean;
declare const status: { status?: 418 };
declare const discard: { discard?: boolean };
declare const unchecked: { unchecked?: boolean };

describe("bound calls", () => {
  const api = c.bind(
    {
      getUser: c.endpoint("/users/:id", {
        responses: {
          200: { body: c.type<{ id: number }>(), headers: c.type<{ "x-team": string }>() },
          404: "none",
        },
      }),
      health: c.endpoint("/health"),
      post: c.endpoint("/users", { method: "POST", responses: { 201: "none" } }),
    },
    fetchTransport(),
  );

  test("infer request fixtures and retain status and response metadata", async () => {
    const input = { path: { id: 7 }, status: 200, cache: "no-store" } satisfies InferInput<typeof api.getUser>;

    const result = await api.getUser(input);

    expectTypeOf(result).toEqualTypeOf<InferResponse<typeof api.getUser, 200>>();
    expectTypeOf(result.body).toEqualTypeOf<{ id: number }>();
    expectTypeOf(result.headers).toEqualTypeOf<{ "x-team": string }>();
    expectTypeOf(result.transport?.redirected).toEqualTypeOf<boolean | undefined>();

    // @ts-expect-error checked fixtures require the path parameter
    ({ status: 200 }) satisfies InferInput<typeof api.getUser>;
    // @ts-expect-error unchecked calls have a different input shape
    ({ path: { id: 7 }, unchecked: true }) satisfies InferInput<typeof api.getUser>;
    // @ts-expect-error Fetch cache options are checked
    await api.getUser({ path: { id: 7 }, cache: "bad" });
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
    // @ts-expect-error unchecked mode still requires a status
    await api.health({ unchecked: true });
    // @ts-expect-error status-only input fixtures also require a status
    ({}) satisfies InferInput<typeof api.health>;
    // @ts-expect-error a literal empty list cannot accept any status
    await api.getUser({ path: { id: 7 }, status: [] });
  });

  test("permit malformed requests only with explicit unchecked mode", async () => {
    const optionalOverride: { unchecked?: true } = flag ? { unchecked: true } : {};

    const malformed = await api.getUser({
      unchecked: true,
      path: "/broken",
      bodyKind: "text",
      body: "{bad",
      status: [200, 422],
      discard: true,
      cache: "no-store",
    });
    expectTypeOf(malformed.status).toEqualTypeOf<200 | 422>();
    expectTypeOf(malformed.body).toEqualTypeOf<undefined>();

    const valid = await api.getUser({ path: { id: 7 }, status: 200, ...unchecked });
    expectTypeOf(valid.body).toEqualTypeOf<{ id: number }>();

    // @ts-expect-error unchecked mode still requires a path
    await api.getUser({ unchecked: true });
    // @ts-expect-error checked calls need a scalar path parameter
    await api.getUser({ path: { id: new Date() } });
    // @ts-expect-error raw path is an unchecked override
    await api.getUser({ path: "/broken", unchecked: flag });
    // @ts-expect-error an optional true may leave request checks enabled
    await api.getUser({ path: "/broken", ...optionalOverride });
    // @ts-expect-error overriding the body kind requires unchecked mode
    await api.getUser({ path: { id: 7 }, bodyKind: "text", body: "{bad" });
    // @ts-expect-error unchecked text still requires a string
    await api.getUser({ unchecked: true, path: "/broken", bodyKind: "text", body: 7 });
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

describe("schemas and body kinds", () => {
  test("infer recursive JSON request and response types", async () => {
    interface Category {
      name: string;
      children: Category[];
    }

    const save = c.bind(
      c.endpoint("/categories", {
        method: "POST",
        body: c.type<Category>(),
        responses: { 200: c.type<Category>() },
      }),
      fetchTransport(),
    );
    const result = await save({ body: { name: "Root", children: [] } });

    expectTypeOf<InferInput<typeof save>["body"]>().toEqualTypeOf<Category>();
    expectTypeOf(result.body).toEqualTypeOf<Category>();
    // @ts-expect-error the declared body still requires children
    await save({ body: { name: "Root" } });
  });

  const transform = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => ({ value: { id: 7 } }),
      types: {} as { input: string; output: { id: number } },
    },
  } as const;

  test("infer the request schema input and response schema output", async () => {
    const create = c.bind(
      c.endpoint("/users", {
        method: "POST",
        body: transform,
        responses: { 200: { body: { kind: "text", schema: transform } } },
      }),
      fetchTransport(),
    );

    expectTypeOf<InferInput<typeof create>["body"]>().toEqualTypeOf<string>();
    expectTypeOf((await create({ body: "Ada" })).body).toEqualTypeOf<{ id: number }>();

    // @ts-expect-error request input differs from the wire value
    await create({ body: { id: 7 } });
    // @ts-expect-error a dynamic flag may leave the request validator enabled
    await create({ body: { id: 7 }, unchecked: flag });
  });

  test("check built-in schema kinds at declaration and native kinds at bind", async () => {
    c.endpoint("/text", {
      // @ts-expect-error text request schemas must produce strings
      body: { kind: "text", schema: c.type<number>() },
    });
    const invalid = c.endpoint("/download", {
      responses: { 200: { kind: "blob", schema: c.type<string>() } },
    });
    // @ts-expect-error Fetch decodes blob as Blob
    c.bind(invalid, fetchTransport());

    const download = c.bind(
      c.endpoint("/download", { responses: { 200: "blob" } }),
      fetchTransport(),
    );
    expectTypeOf((await download()).body).toEqualTypeOf<Blob>();

    const stream = c.endpoint("/download", {
      responses: { 200: { kind: "stream", schema: transform } },
    });
    // @ts-expect-error Fetch supplies a stream and this schema expects a string
    c.bind(stream, fetchTransport());
  });

  test("check multipart file data when declaring the endpoint", () => {
    c.endpoint("/files", {
      body: { kind: "multipart", schema: c.type<{ file: { data: Uint8Array } }>() },
    });

    c.endpoint("/files", {
      // @ts-expect-error a portable file descriptor needs binary data
      body: { kind: "multipart", schema: c.type<{ file: { data: number } }>() },
    });
  });

  test("require inputs valid for every possible request kind", async () => {
    const body = flag ? "json" : "none";
    const send = c.bind(
      c.endpoint("/data", {
        method: "POST",
        body,
        responses: { 204: "none" },
      }),
      fetchTransport(),
    );

    await send();
    // @ts-expect-error the chosen kind may forbid a body
    await send({ body: { id: 7 } });
    await send({ unchecked: true, bodyKind: "json", body: { id: 7 } });
  });

  test("check each custom kind against the bound transport", () => {
    const adapter: Transport<
      { nativeText: string; nativeNumber: number },
      { none: undefined }
    > = async ({ url }) => ({ status: 204, url, headers: {}, read: async () => undefined });
    const valid = flag
      ? ({ kind: "nativeText", schema: c.type<string>() } as const)
      : ({ kind: "nativeNumber", schema: c.type<number>() } as const);
    c.bind(c.endpoint("/native", { body: valid, responses: { 204: "none" } }), adapter);

    const invalid = flag
      ? ({ kind: "nativeText", schema: c.type<number>() } as const)
      : ({ kind: "nativeNumber", schema: c.type<string>() } as const);
    // @ts-expect-error each union member must match its own transport kind
    c.bind(c.endpoint("/native", { body: invalid, responses: { 204: "none" } }), adapter);
  });
});

test("retain custom transport options, callback types, and response metadata", async () => {
  type Options = { trace: { id: string }; onTrace?: (id: string) => void };
  type Responses = Pick<ResponseKindMap, "json" | "none">;
  const adapter: Transport<RequestKindMap, Responses, Options, { traceId: string }> = async ({
    input,
    url,
  }) => {
    const traceId = input?.trace.id ?? "";
    input?.onTrace?.(traceId);
    const decoded: Responses = { none: undefined, json: { id: 7 } };
    return {
      url,
      status: 200,
      headers: {},
      transport: { traceId },
      read: async <Kind extends keyof Responses>(kind: Kind) => decoded[kind],
    };
  };
  const get = c.bind(
    c.endpoint("/users/:id", {
      responses: { 200: c.type<{ id: number }>() },
    }),
    adapter,
  );

  const input = {
    path: { id: 7 },
    trace: { id: "r1" },
    onTrace: (id) => expectTypeOf(id).toEqualTypeOf<string>(),
  } satisfies InferInput<typeof get>;

  const result = await get(input);
  expectTypeOf(result.transport?.traceId).toEqualTypeOf<string | undefined>();

  const raw = await get({
    unchecked: true,
    path: "/malformed",
    status: 400,
    trace: { id: "r2" },
    onTrace: (id) => expectTypeOf(id).toEqualTypeOf<string>(),
  });
  expectTypeOf(raw.status).toEqualTypeOf<400>();

  // @ts-expect-error the transport requires trace
  await get({ path: { id: 7 } });
  // @ts-expect-error unchecked mode still requires the transport's trace option
  await get({ unchecked: true, path: "/malformed" });
});

test("narrow ClientError diagnostics by code and reason", (error?: unknown) => {
  if (!(error instanceof ClientError)) {
    return;
  }

  if (error.code === "status") {
    expectTypeOf(error.expectedStatuses).toEqualTypeOf<readonly number[]>();
    expectTypeOf(error.headers).toEqualTypeOf<ResponseHeaders>();
  }
  if (error.code === "request-schema") {
    // @ts-expect-error request errors have no response status
    error.status;
    if (error.reason === "issues") {
      expectTypeOf(error.issues[0]?.message).toEqualTypeOf<string | undefined>();
    } else {
      // @ts-expect-error validator exceptions do not carry issues
      error.issues;
    }
  }

  // @ts-expect-error status failures require the accepted statuses
  new ClientError({ code: "status", method: "GET", status: 503, headers: {} });
});
