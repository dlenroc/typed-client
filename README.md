# @dlenroc/typed-client

Declare typed HTTP endpoints and call them through Fetch, Playwright, or k6.

## Install

```sh
npm install @dlenroc/typed-client
```

The package uses ESM. Fetch works in Node.js 24+ and in browsers with
`AbortSignal.any`.

## `c.endpoint(url, definition?)`

`method` defaults to `GET`. A full `:name` path segment requires a matching
field in `path`, and the client URL-escapes its value.

```ts
import { c } from "@dlenroc/typed-client";

type User = { id: number; name: string };

export const getUser = c.endpoint("/users/:id", {
  responses: {
    200: c.type<User>(),
    404: "none",
  },
  meta: { operationId: "getUser" },
});
```

`c.type<T>()` supplies a compile-time type. Use a
[Standard Schema validator](#runtime-validation) to check values at runtime.

## `c.bind(endpointOrGroup, transport)`

Bind one endpoint to get a callable function, or bind an object of endpoints
to preserve its nested names.

```ts
import { c } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { getUser } from "./users.js";

const transport = fetchTransport({
  baseUrl: "https://api.example.test/v1",
});

const get = c.bind(getUser, transport);
const { body } = await get({ path: { id: 42 }, status: 200 });
console.log(body.name);

const api = c.bind({ users: { get: getUser } }, transport);

const result = await api.users.get({ path: { id: 42 } });
if (result.status === 200) {
  console.log(result.body.name);
}
```

The built-in transports append relative endpoints to the path in `baseUrl`.
Both calls use `https://api.example.test/v1/users/42`. `fetchTransport` also
accepts `fetch`, a replacement for `globalThis.fetch`.

## Bodies

Without a `body` declaration, a call accepts an optional JSON body. Use
`c.type<T>()` or a schema to give callers a typed JSON body.

```ts
const createUser = c.bind(
  c.endpoint("/users", {
    method: "POST",
    body: c.type<{ name: string }>(),
    responses: { 201: "none" },
  }),
  transport,
);

await createUser({ body: { name: "Ada" } });
```

Use a kind such as `"text"` instead of JSON, `{ kind, schema }` to validate
it, or `"none"` to forbid a request body.

Response entries accept the same declarations. Use `{ body, headers }` to add
a response header schema, for example `404: { body: "none", headers }`.

| Kind         | Request value                   | Decoded response                   |
| ------------ | ------------------------------- | ---------------------------------- |
| `none`       | Omit the body                   | `undefined`                        |
| `json`       | Passed to `JSON.stringify`      | Parsed JSON                        |
| `text`       | String                          | String                             |
| `binary`     | `ArrayBuffer` or view           | `Uint8Array`                       |
| `urlencoded` | Encoded string or fields        | Record of strings or arrays        |
| `multipart`  | Fields with text or file values | Record of strings, files or arrays |

Fetch also supports `blob` and `stream` responses. Consume or cancel a
returned stream when you finish with it.

If the body is absent or `undefined`, the client sends no body and no default
`Content-Type`. The client sends JSON `null` as a value. If JSON serialization
fails, the call throws a `request` error. Do not send a body with Fetch `GET`
or `HEAD`.

### Fields, headers and files

Query, URL-encoded, and multipart fields accept records or arrays of
`[name, value]` pairs. Repeat a name in the pairs or use an array as a record
value. `undefined` omits a field and `null` sends an empty value. A query or
URL-encoded body also accepts an encoded string.

```ts
await api.users.get({
  path: { id: 42 },
  query: { tag: ["one", "two"], blank: null, omitted: undefined },
});

const upload = c.bind(
  c.endpoint("/files", {
    method: "POST",
    body: "multipart",
    responses: { 204: "none" },
  }),
  transport,
);

await upload({
  body: {
    tag: ["one", "two"],
    file: { data: new Uint8Array([1, 2]), filename: "data.bin" },
  },
});
```

File values accept `data`, `filename?`, and `mediaType?`. The defaults are
`blob` and `application/octet-stream`. A binary view sends its selected byte
range. Fetch and Playwright accept `FormData` as the body. k6 accepts
`http.file()` values as fields.

Headers accept a record. Header names are case-insensitive. If a name repeats,
the client sends the last value. `undefined` allows a default value, `null`
suppresses the header and its default, and `""` sends an empty value. With
Playwright, do not set `content-type: null` on a request with a body.

A checked call is a call without `unchecked: true`. Checked multipart calls use
the encoder's boundary. To send a custom `Content-Type` in a negative test, use
`unchecked: true`.

## Runtime validation

Validators for `path`, `query`, `headers`, and `body` follow
[Standard Schema](https://standardschema.dev/).

```ts
import { z } from "zod";

const getVerifiedUser = c.bind(
  c.endpoint("/users/:id", {
    responses: { 200: z.object({ id: z.number(), name: z.string() }) },
  }),
  transport,
);

const { body: user } = await getVerifiedUser({ path: { id: 42 } });
```

Request schemas receive the call inputs. Response schemas receive raw headers
or a decoded body. Both can validate or transform values asynchronously.

If a stream schema acquires a reader, release its lock before returning or
throwing. If the schema replaces the stream with another value, consume or
cancel the original stream.

### Reuse inferred types

Keep schemas inline and derive types from the bound endpoint. `InferInput`
includes request fields and transport options for checked calls.

```ts
import type { InferInput, InferResponse } from "@dlenroc/typed-client";

const input = {
  path: { id: 42 },
  status: 200,
} satisfies InferInput<typeof getVerifiedUser>;

type VerifiedUser = InferResponse<typeof getVerifiedUser, 200>["body"];
```

`InferResponse` includes the body and the `transport` field. It defaults to
all declared statuses. Pass one status or a union to select results. For an
endpoint without declared responses, pass the status you expect.

## Call options and statuses

Request fields and call options share one object. Native transport options
go under `transport`.

```ts
await api.users.get({
  path: { id: 42 },
  status: 200,
  timeout: 5000,
});
```

| Option      | Behavior                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| `status`    | Accept one status or a nonempty array and narrow the result.               |
| `unchecked` | Skip request schemas and allow `method`, `path`, and `bodyKind` overrides. |
| `discard`   | Check status and headers, then discard the body before decoding.           |
| `timeout`   | Milliseconds to wait. Defaults to k6: 60 s, Playwright: 30 s.              |
| `follow`    | Follow redirects and return the final response. Defaults to `false`.       |
| `transport` | Native options for the bound transport.                                    |

The built-in transports support `timeout`, `follow`, and `transport`.

Without `follow`, declare the 3xx status or accept it with `status`. In a
browser, Fetch reports an unfollowed redirect as status 0.

`transport` accepts the native request options, except the method, headers,
and body, which the client sets. A native redirect option overrides `follow`.
On k6, a native `timeout` overrides `timeout`. On Fetch, the client combines a
native `signal` with `timeout`.

```ts
await api.users.get({ path: { id: 42 }, transport: { signal: controller.signal } });
```

Calls accept all declared statuses by default, including 4xx and 5xx.
If there are no declared responses, pass `status` on each call. Accepted
undeclared statuses return raw headers and `body: undefined`.

```ts
const health = c.bind(c.endpoint("/health"), transport);
await health({ status: 204 });
```

### Negative testing

```ts
await createUser({
  unchecked: true,
  bodyKind: "text",
  body: "{broken",
  headers: { "content-type": "application/json" },
  status: 400,
});
```

This sends malformed JSON as raw text and expects HTTP 400. Use a `path`
string to replace the endpoint path or send the request to an absolute URL.
Declared responses still use their schemas.

## Responses and errors

Responses contain `status`, `url`, `headers`, and `body`. Raw headers use
lowercase names and preserve repeated values when the native API exposes them
separately. The `transport` field carries metadata such as Fetch `redirected`,
Playwright `statusText`, or k6 `timings`.

```ts
import { ClientError } from "@dlenroc/typed-client";

try {
  await api.users.get({ path: { id: 42 }, status: 200 });
} catch (error) {
  if (error instanceof ClientError && error.code === "status") {
    console.error(error.meta.operationId, error.status);
  }

  throw error;
}
```

| Code        | When it occurs                                                                    | Fields                       |
| ----------- | --------------------------------------------------------------------------------- | ---------------------------- |
| `request`   | Nothing was sent because the call input, URL, preparation, or a schema failed.    | `schema`, `issues`           |
| `transport` | The transport failed to deliver or release a response.                            | `status` if any              |
| `status`    | The status falls outside the accepted set.                                        | `status`                     |
| `response`  | The body cannot be decoded, or a response schema rejects the response.            | `status`, `schema`, `issues` |

Every `ClientError` includes `method`, `meta`, and `cause`. `url` is set when
available. `schema` names the schema that failed: `path`, `query`, `headers`,
or `body`. That schema either reported `issues` or threw `cause`. A `response`
error without `schema` means the body could not be decoded.

If cleanup fails as well, `cleanupError` holds the secondary failure.
Reporters that serialize errors can read `code`, `meta`, and the other
enumerable fields. Read `message` and `cause` explicitly when building a
JSON report.

## Other transports

### Playwright

Use Playwright 1.62 or later. Pass Playwright Test's `request` fixture to the
transport as its `context`.

```ts
import { test } from "@playwright/test";
import { c } from "@dlenroc/typed-client";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import { getUser } from "./users.js";

test("get user", async ({ request }) => {
  const get = c.bind(
    getUser,
    playwrightTransport({
      context: request,
      baseUrl: "https://api.example.test/v1",
    }),
  );
  await get({ path: { id: 42 }, status: 200 });
});
```

`@playwright/test` already brings in `playwright-core`. If TypeScript reports
that it cannot find `playwright-core` in the transport's declarations, install
`playwright-core@^1.62.0` directly.

For a standalone script:

1. Install `playwright-core` and import `request` from it.
2. Create a context with `request.newContext()`.
3. Dispose the context when finished.

### k6

Use k6 2.2 or later. For TypeScript checking, add `@types/k6@^2.2.0` as a dev
dependency. `k6Transport` also accepts `http`, a replacement for the `k6/http`
module.

```ts
import { c } from "@dlenroc/typed-client";
import { k6Transport } from "@dlenroc/typed-client/k6";
import { getUser } from "./users.js";

const loadGet = c.bind(
  getUser,
  k6Transport({
    baseUrl: "https://api.example.test/v1",
  }),
);

export default async function () {
  await loadGet({ path: { id: 42 }, status: 200 });
}
```

See [Loading npm packages in k6](https://grafana.com/docs/k6/latest/using-k6/modules/#use-nodejs-modules).

## Custom transports

A `Transport` takes a prepared `TransportRequest` and returns a promise of a
`TransportResponse`. Use the kind maps to describe what it can send and decode.

```ts
import { c, type RequestKindMap, type Transport } from "@dlenroc/typed-client";

const empty: Transport<RequestKindMap, { none: undefined }> =
  async ({ url }) => ({
    url,
    status: 204,
    headers: {},
    read: async () => undefined,
  });

const endpoint = c.endpoint("/ping", { responses: { 204: "none" } });
const ping = c.bind(endpoint, empty);
await ping();
```

- Read native options from `request.input`.
- To support `timeout` and `follow`, add `CommonOptions` to the transport's
  options and apply them from `request.input`.
- Release buffered resources in `read()`. This includes `read("none")`, which
  the client calls to skip decoding.
- If resources can stay live after `read()`, for example a returned stream,
  implement `discard()`. The client calls it when a status or schema check
  rejects the response.
- The caller owns live resources that a successful call returns.
