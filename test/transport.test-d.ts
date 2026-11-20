import { describe, expectTypeOf, test } from "vitest";
import {
  c,
  type InferInput,
  type RequestKindMap,
  type ResponseKindMap,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "@dlenroc/typed-client";
import { type FetchTransport, fetchTransport } from "@dlenroc/typed-client/fetch";
import { type K6Transport, k6Transport } from "@dlenroc/typed-client/k6";
import { type PlaywrightTransport, playwrightTransport } from "@dlenroc/typed-client/playwright";
import type { APIRequestContext } from "playwright-core";

declare const context: APIRequestContext;
declare const flag: boolean;

type AnyTransport = Transport<any, {}, any, any>;
type Requests<T> = T extends (request: TransportRequest<infer R, any, any>) => unknown ? R : never;
type Responses<T> = T extends (request: TransportRequest<any, infer R, any>) => unknown ? R : never;
type Options<T> = T extends (request: TransportRequest<any, any, infer O>) => unknown ? O : never;
type Metadata<T> = T extends (...args: never[]) => Promise<{ readonly transport?: infer M }> ? M : never;

// A decorator that adds a transport option, written over the whole transport type.
declare function retry<T extends AnyTransport>(
  next: T,
): Transport<
  Requests<T> & object,
  Responses<T> & object,
  Options<T> & { readonly retries?: number },
  Metadata<T> & object
>;

// The same decorator, written over the four type parameters.
declare function retryEach<Q extends object, S extends object, O, M extends object>(
  next: Transport<Q, S, O, M>,
): Transport<Q, S, O & { readonly retries?: number }, M>;

// No cast: the decorator names the four type parameters of the transport.
function withHeader<Q extends object, S extends object, O, M extends object>(
  next: Transport<Q, S, O, M>,
  value: () => string | Promise<string>,
): Transport<Q, S, O, M> {
  return async (request) =>
    next({ ...request, headers: { authorization: await value(), ...request.headers } });
}

const api = { get: c.endpoint("/users/{id}", { responses: { 200: c.json<{ id: number }>() } }) };
const base = fetchTransport();
type FetchMetadata = { readonly redirected: boolean; readonly type: ResponseType };

test("a decorator written inline keeps the call types", async () => {
  const ada = c.bind(api, withHeader(base, async () => "Bearer ada"));

  const ok = await ada.get({ path: { id: 1 }, status: 200, timeout: 5, transport: { cache: "no-store" } });

  expectTypeOf(ok.body).toEqualTypeOf<{ id: number }>();
  expectTypeOf(ok.transport).toEqualTypeOf<FetchMetadata>();

  const denied = await ada.get({ path: { id: 1 }, headers: { authorization: null }, status: 401 });
  expectTypeOf(denied.status).toEqualTypeOf<401>();
  expectTypeOf(denied.body).toEqualTypeOf<undefined>();

  // @ts-expect-error missing path parameter
  await ada.get({ status: 200 });
  // @ts-expect-error unknown transport option
  await ada.get({ path: { id: 1 }, transport: { nope: 1 } });
  // @ts-expect-error transport options are not top-level fields
  await ada.get({ path: { id: 1 }, cache: "no-store" });
  // @ts-expect-error bind has two parameters
  c.bind(api, base, { headers: {} });
});

test("a decorator that adds an option exposes it under transport", async () => {
  for (const transport of [retry(base), retryEach(base)]) {
    const bound = c.bind(api, transport);
    const result = await bound.get({ path: { id: 1 }, transport: { retries: 2 }, status: 200 });

    expectTypeOf(result.body).toEqualTypeOf<{ id: number }>();
    expectTypeOf(result.transport!.redirected).toBeBoolean();
    // @ts-expect-error a transport option is not a top-level field
    await bound.get({ path: { id: 1 }, retries: 2 });
  }
});

test("a custom transport reads the endpoint", async () => {
  const seen: string[] = [];
  const mock: Transport<RequestKindMap, Pick<ResponseKindMap, "json" | "none">> = async (request) => {
    seen.push(`${request.method} ${request.endpoint.template} ${String(request.endpoint.meta.operationId)}`);
    return { status: 200, url: request.url, headers: {}, read: async () => ({ id: 1 }) as never };
  };

  const r = await c.bind(api, mock).get({ path: { id: 1 } });
  expectTypeOf(r.body).toEqualTypeOf<{ id: number }>();
});

test("bind checks the whole contract against the transport", () => {
  const contract = {
    users: {
      get: api.get,
      feed: c.endpoint("/feed", { responses: { 200: c.kind("stream") } }),
    },
  };
  interface Services { users: typeof contract.users }
  const services: Services = contract;
  c.bind(services, fetchTransport());

  const k6 = k6Transport();
  // @ts-expect-error k6 cannot decode the stream at users.feed
  c.bind(contract, k6);
  // @ts-expect-error a function is not a group
  c.bind({ get: () => api.get }, fetchTransport());
  // @ts-expect-error invalid leaf at users.get
  c.bind({ users: { get: null } }, fetchTransport());
});

test("each transport factory returns its named type", () => {
  expectTypeOf(fetchTransport()).toEqualTypeOf<FetchTransport>();
  expectTypeOf(
    playwrightTransport({ context: {} as APIRequestContext }),
  ).toEqualTypeOf<PlaywrightTransport>();
  expectTypeOf(k6Transport()).toEqualTypeOf<K6Transport>();
});

test("diagnostic text is independent of declared response kinds", () => {
  const response = {} as TransportResponse<{ none: undefined }>;
  expectTypeOf(response.read("text")).toEqualTypeOf<Promise<string | undefined>>();
  expectTypeOf(response.read("none")).toEqualTypeOf<Promise<undefined>>();

  const withText = {} as TransportResponse<{ text: string }>;
  expectTypeOf(withText.read("text")).toEqualTypeOf<Promise<string>>();

  const get = c.endpoint("/text", { responses: { 200: c.text() } });
  const adapter: Transport<RequestKindMap, { none: undefined }> =
    async ({ url }) => ({ url, status: 500, headers: {}, read: async () => undefined });
  // @ts-expect-error diagnostic text does not enable a text endpoint
  c.bind(get, adapter);
});

test("retain custom transport options, callback types, and response metadata", async () => {
  type Options = { trace: { id: string }; onTrace?: (id: string) => void };
  type Responses = Pick<ResponseKindMap, "json" | "none">;

  const adapter: Transport<RequestKindMap, Responses, Options, { traceId: string }> = async ({
    options,
    url,
  }) => {
    const traceId = options?.trace.id ?? "";
    options?.onTrace?.(traceId);

    const decoded: Responses & { text: string | undefined } = {
      none: undefined,
      json: { id: 7 },
      text: undefined,
    };

    return {
      url,
      status: 200,
      headers: {},
      transport: { traceId },
      read: async (kind) => decoded[kind],
    };
  };

  const get = c.bind(
    c.endpoint("/users/{id}", {
      responses: { 200: c.json<{ id: number }>() },
    }),
    adapter,
  );

  const input = {
    path: { id: 7 },
    transport: {
      trace: { id: "r1" },
      onTrace: (id) => expectTypeOf(id).toEqualTypeOf<string>(),
    },
  } satisfies InferInput<typeof get>;

  const result = await get(input);
  expectTypeOf(result.transport.traceId).toEqualTypeOf<string>();

  const raw = await get({
    path: c.raw("/malformed"),
    status: 400,
    transport: {
      trace: { id: "r2" },
      onTrace: (id) => expectTypeOf(id).toEqualTypeOf<string>(),
    },
  });
  expectTypeOf(raw.status).toEqualTypeOf<400>();

  // @ts-expect-error the transport requires trace
  await get({ path: { id: 7 } });
  // @ts-expect-error a raw part still requires the transport's trace option
  await get({ path: c.raw("/malformed") });
});

describe("transport kinds", () => {
  test("each transport binds only the kinds it supports", async () => {
    const download = c.endpoint("/file", { responses: { 200: c.kind("blob"), 206: c.kind("stream") } });
    const result = await c.bind(download, fetchTransport())();

    if (result.status === 200) {
      expectTypeOf(result.body).toEqualTypeOf<Blob>();
    } else {
      expectTypeOf(result.body).toEqualTypeOf<ReadableStream<Uint8Array>>();
    }

    // @ts-expect-error Playwright has no blob kind
    c.bind(download, playwrightTransport({ context }));
    // @ts-expect-error k6 has no blob kind
    c.bind(download, k6Transport());
  });

  test("metadata and native options follow the bound transport", async () => {
    const ping = c.endpoint("/ping", { responses: { 204: c.none() } });

    expectTypeOf((await c.bind(ping, fetchTransport())()).transport.redirected).toEqualTypeOf<boolean>();
    expectTypeOf((await c.bind(ping, k6Transport())()).transport.timings.duration).toEqualTypeOf<number>();

    await c.bind(ping, playwrightTransport({ context }))({ transport: { maxRedirects: 2 } });
    // @ts-expect-error Playwright keeps `failOnStatusCode` to itself
    await c.bind(ping, playwrightTransport({ context }))({ transport: { failOnStatusCode: true } });
    // @ts-expect-error k6 keeps `responseType` to itself
    await c.bind(ping, k6Transport())({ transport: { responseType: "binary" } });
  });
});

test("Fetch accepts stream and blob request kinds", () => {
  const upload = {
    stream: c.endpoint("/upload", { method: "POST", body: c.kind("stream"), responses: { 204: c.none() } }),
    blob: c.endpoint("/upload", { method: "POST", body: c.kind("blob"), responses: { 204: c.none() } }),
  };
  const send = c.bind(upload, fetchTransport());

  void send.stream({ body: new ReadableStream<Uint8Array>() });
  void send.blob({ body: new Blob(["x"]) });
  // @ts-expect-error a stream body must be a ReadableStream
  void send.stream({ body: c.text() });
  // @ts-expect-error a blob body must be a Blob
  void send.blob({ body: new Uint8Array([1]) });

  const playwright = playwrightTransport({ context });
  // @ts-expect-error Playwright has no stream request kind
  c.bind(upload.stream, playwright);
  // @ts-expect-error Playwright has no blob request kind
  c.bind(upload.blob, playwright);
});

test("check each custom kind against the bound transport", () => {
  const adapter: Transport<
    { nativeText: string; nativeNumber: number },
    { none: undefined }
  > = async ({ url }) => ({ status: 204, url, headers: {}, read: async () => undefined });

  const valid = flag
    ? c.kind("nativeText", c.type<string>())
    : c.kind("nativeNumber", c.type<number>());
  c.bind(c.endpoint("/native", { body: valid, responses: { 204: c.none() } }), adapter);

  const invalid = flag
    ? c.kind("nativeText", c.type<number>())
    : c.kind("nativeNumber", c.type<string>());
  // @ts-expect-error each union member must match its own transport kind
  c.bind(c.endpoint("/native", { body: invalid, responses: { 204: c.none() } }), adapter);
});

test("unknown transport options accept any keys", async () => {
  const loose: Transport<RequestKindMap, ResponseKindMap, unknown> = async ({ url }) => ({
    url,
    status: 204,
    headers: {},
    read: async () => undefined as never,
  });

  await c.bind(c.endpoint("/ping", { responses: { 204: c.none() } }), loose)({ transport: { retries: 1 } });
});
