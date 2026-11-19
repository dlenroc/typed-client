# @dlenroc/typed-client

Declare typed HTTP endpoints and call them through Fetch, Playwright, or k6.

## Install

```sh
npm install @dlenroc/typed-client
```

The package uses ESM. Fetch works in Node.js 24+ and in browsers with
`AbortSignal.any`.

## Declare and call an endpoint

```ts
import { c } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

type User = { id: number; name: string };

export const create = c.endpoint("/users", {
  method: "POST",
  body: c.json<{ name: string }>(),
  responses: {
    201: c.json<User>(),
    422: c.json<{ issues: string[] }>(),
  },
  meta: { operationId: "createUser" },
});

const transport = fetchTransport({ baseUrl: "https://api.example.test/v1" });
const createUser = c.bind(create, transport);

const result = await createUser({ body: { name: "" } });
if (result.status === 422) {
  console.log(result.body.issues);
} else {
  console.log(result.body.id);
}

const created = await createUser({ body: { name: "Ada" }, status: 201 });
console.log(created.body.name);

await createUser({ body: c.raw("{broken"), status: 400 });
```

The call accepts the declared statuses by default. Passing `status: 201`
narrows the result to the created user and throws for any other status.
The last call sends malformed JSON to test the server's 400 response.

`c.endpoint` defaults to GET. Each `{name}` before `?` or `#` is a required
path parameter. The client percent-encodes its value. Parameters can be
part of a segment, as in `/files/{name}.json`. An empty `{}` stays literal.

Bind a group to keep its names:

```ts
export const getUser = c.endpoint("/users/{id}", { responses: { 200: c.json<User>() } });
const api = c.bind({ users: { get: getUser, create } }, transport);
const user = await api.users.get({ path: { id: 42 } });
```

The endpoint exposes its method, template, path parameters, request,
responses and metadata. For example, `create.method` has the literal type
`"POST"`. `fetchTransport` accepts a replacement `fetch` for testing.

### Base URL

`baseUrl` is a prefix. The transport does not add or remove slashes, so write
`baseUrl` without a final slash and templates with an initial slash. How the
base URL applies depends on how the template starts. Parameter values do not
change it.

| Call, with `baseUrl: "https://api.test/v1"` | Sent                          |
| ------------------------------------------- | ----------------------------- |
| Template `/users/{id}`, `id: 7`             | `https://api.test/v1/users/7` |
| Template `https://other.test/users/{id}`    | `https://other.test/users/7`  |
| Template `//cdn.test/{file}`, `file: "a"`   | `https://cdn.test/a`          |

A template that starts with `//` keeps its host and gets the scheme of
`baseUrl`.

## Bodies

Without a `body` declaration, a call sends no body. A kind helper declares a
body. A type argument or a schema gives it a type.

Response entries use the same helpers. Use `{ body, headers }` to add a
response header schema, for example `404: { headers }`. Without `body`, the
response has no body.

| Helper           | Request value                   | Decoded response                   |
| ---------------- | ------------------------------- | ---------------------------------- |
| `c.none()`       | Omit the body                   | `undefined`                        |
| `c.json()`       | Passed to `JSON.stringify`      | Parsed JSON                        |
| `c.text()`       | String                          | String                             |
| `c.binary()`     | `ArrayBuffer` or view           | `Uint8Array<ArrayBuffer>`          |
| `c.urlencoded()` | Encoded string or fields        | Record of strings or arrays        |
| `c.multipart()`  | Fields with text or file values | Record of strings, files or arrays |

Each helper takes an optional schema, for example `c.text(schema)`.
`c.json<T>()`, `c.text<T>()`, `c.urlencoded<T>()`, and `c.multipart<T>()` also
take a type argument. `c.kind(name, schema?)` declares a kind of the bound
transport, for example `c.kind("blob")`.

Fetch also sends `c.kind("blob")` and `c.kind("stream")` bodies and decodes
them as responses. A `blob` body is a `Blob` or `File`. Fetch uses its `type`, if not
empty, as the default `Content-Type`. A `stream` body is a `ReadableStream` of
bytes. Chromium requires HTTP/2 or later for a streamed upload. Fetch reads
the stream once while it sends the body. With
`follow: true`, a redirect other than 303 fails for a `stream` body. Consume or
cancel a returned stream when you finish with it.

Without a body, the client sends no default `Content-Type`. The client sends
JSON `null` as a value. If JSON serialization
fails, the call throws a `request` error. Do not send a body with Fetch `GET`
or `HEAD`.

### Fields, headers and files

Query, URL-encoded, and multipart fields accept records or arrays of
`[name, value]` pairs. Repeat a name in the pairs or use an array as a record
value. `null` sends an empty value. A query or
URL-encoded body also accepts an encoded string. A value with an interface type has no
index signature, so declare that part with its type, for example
`query: c.type<Filter>()`.

```ts
await api.users.get({
  path: { id: 42 },
  query: { tag: ["one", "two"], blank: null, omitted: undefined },
});

const upload = c.bind(
  c.endpoint("/files", {
    method: "POST",
    body: c.multipart(),
    responses: { 204: c.none() },
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

Headers accept a record. The client sends header names as given. Names that
differ only in case are one header, so the client sends the last spelling and
the last value. k6, Playwright, and HTTP/2 can change the case. `null`
suppresses the header and its library default, and `""` sends an empty value.
Playwright still applies headers set on its request context. For anonymous
tests, use a context without inherited authorization. Playwright also requires
a content type when sending a body.

A multipart call uses the encoder's boundary, so the client removes a
`Content-Type` that the call supplies. To send your own `Content-Type` in a
negative test, pass the headers as [`c.raw`](#negative-testing).

## Runtime validation

Validators for `path`, `query`, `headers`, and `body` follow
[Standard Schema](https://standardschema.dev/).

```ts
import { z } from "zod";

const getVerifiedUser = c.bind(
  c.endpoint("/users/{id}", {
    responses: { 200: c.json(z.object({ id: z.number(), name: z.string() })) },
  }),
  transport,
);

const { body: user } = await getVerifiedUser({ path: { id: 42 } });
```

Request schemas receive the call inputs. Response schemas receive raw headers
or a decoded body. Both can validate or transform values asynchronously.

`c.type<T>()` gives `path`, `query`, or `headers` a compile-time type without
validation, and works as a schema in any kind helper, for example
`c.text(c.type<"ok">())`.

### Reuse inferred types

```ts
import type { InferInput, InferResponse } from "@dlenroc/typed-client";

const input = { body: { name: "Ada" } } satisfies InferInput<typeof create>;
type CreatedUser = InferResponse<typeof create, 201>["body"];
```

When a flag changes which fields or responses exist, construct the endpoint
in the corresponding branch. A conditional spread can hide a required
field, so TypeScript rejects it at the declaration.

If one validator accepts a narrower input than another, TypeScript can infer
the wider type for `flag ? a : b`. Choose the validator and make the call in
the same branch when the narrower input matters.

For generated clients, export the endpoint declarations from a shared package
and bind them in each runtime. A flat registry can use
`satisfies Record<string, Endpoint>` to check its entries and preserve their
literal paths and statuses.
Use the bound function when you also need native transport options, response
metadata, or the wire type of a transport-specific body kind. Inputs exclude
raw overrides. Responses default to the union of declared statuses.

A shared helper can accept a bound endpoint from Fetch, Playwright, or k6:

```ts
import type { Operation } from "@dlenroc/typed-client";

async function seedUser(createUser: Operation<typeof create>) {
  const { body } = await createUser({ body: { name: "Ada" }, status: 201 });
  return body.id;
}
```

For native options, response metadata, or raw body overrides, use the specific
bound operation type, for example `typeof api.users.create`.

## Call options and statuses

A call takes one object. It holds the request fields `path`, `query`,
`headers`, and `body`, and the call options. Native transport options go
under `transport`.

`undefined` has one meaning everywhere in a call: it is the same as leaving
the value out, so `{ authorization: token }` with no token sends nothing and
keeps a default. `null` is a value: an empty field, a suppressed header, or
JSON `null`.

```ts
await api.users.get({
  path: { id: 42 },
  status: 200,
  timeout: 5000,
});
```

| Option      | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| `status`    | Accept one status or a nonempty array and narrow the result.         |
| `discard`   | Check status and headers, then discard the body before decoding.     |
| `timeout`   | Milliseconds to wait. Defaults to k6: 60 s, Playwright: 30 s.        |
| `follow`    | Follow redirects and return the final response. Defaults to `false`. |
| `method`    | Only a raw value, `c.raw("PATCH")`. It replaces the endpoint method. |
| `transport` | Native options for the bound transport.                              |

A request part is optional when an omitted value is valid:

- `path` is optional when the template has no parameters and no path schema
  is declared.
- `query` and `headers` declared with `c.type<T>()` are optional when every
  key of `T` is optional.
- A part with a schema is optional when the schema accepts `undefined`. The
  schema receives `undefined` and can supply a default.
- `body` is optional for `c.json()` without a type or a schema.

Without `follow`, declare the 3xx status or accept it with `status`. In a
browser, Fetch reports an unfollowed redirect as status 0.

`transport` accepts the native request options, except the method, headers,
and body, which the client sets. A native redirect option overrides `follow`.
On k6, a native `timeout` overrides `timeout`. On Fetch, the client combines a
native `signal` with `timeout`. Use a positive number for a portable deadline.
Zero disables the Playwright timeout and can expire immediately on Fetch and k6.

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

Use `c.raw(value)` to bypass the schema for one request part. The other
parts keep their usual validation and encoding.

```ts
await createUser({ body: c.raw("{broken"), status: 400 });
```

This sends malformed JSON and expects HTTP 400. For a JSON body, a raw string
is the JSON text. The client sends it unchanged with
`Content-Type: application/json`, unless the call sets `Content-Type`. Other
raw JSON values are encoded with `JSON.stringify`. Declared responses still
use their schemas.

| Raw part                                    | Effect                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `path: c.raw("//host/x")`                   | The string replaces the rendered template.                                    |
| `path: { id: c.raw("a/b") }`                | The value of one parameter is not percent-encoded.                            |
| `query: c.raw("a=%ZZ")`                     | The query string, or the query record, skips the query schema.                |
| `headers: c.raw({ "content-length": "9" })` | The record skips the headers schema and keeps a multipart `Content-Type`.     |
| `body: c.raw("{broken")`                    | A string for a JSON body is sent as the JSON text.                            |
| `body: c.raw("{broken", "text")`            | The value is sent with the given body kind. Without a kind, the declared one. |
| `method: c.raw("PATCH")`                    | The method replaces the method of the endpoint.                               |

A raw `path` string follows the same [base URL](#base-url) rules as a
template, so `c.raw("http://other.test/x")` sends to another host.

An endpoint without a `body` declaration accepts no body. To send one anyway,
use `body: c.raw(value, kind)`.

## Responses and errors

Responses contain `status`, `url`, `headers`, and `body`. Header names are
lowercase and each value is a string. Repeated values are joined with
`", "`. Node Fetch and Playwright separate repeated `Set-Cookie` values
with a newline. Browser Fetch hides that header, including on same-origin
requests. The `transport` field carries metadata such as Fetch `redirected`,
Playwright `serverAddr`, or k6 `timings`.

```ts
import { ClientError } from "@dlenroc/typed-client";

try {
  await createUser({ body: { name: "Ada" }, status: 201 });
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
| `transport` | The transport or a decorator failed, or a response could not be released.         | `status` if any              |
| `status`    | The status falls outside the accepted set.                                        | `status`                     |
| `response`  | The body cannot be decoded, or a response schema rejects the response.            | `status`, `schema`, `issues` |

Every `ClientError` includes `method`, `meta`, and `cause`. `url` is set when
available. `schema` names the schema that failed: `path`, `query`, `headers`,
or `body`. That schema either reported `issues` or threw `cause`. A `response`
error without `schema` means the body could not be decoded.

The message names the method and the URL when the URL is known. It lists up to
10 issues, one per line, or gives the first line of the cause and of its cause.
It leaves out URL credentials. The `url` and `cause` fields keep the full
values.

If cleanup fails as well, `cleanupError` holds the secondary failure.

## Other transports

### Playwright

Use Playwright 1.62 or later. Pass Playwright Test's `request` fixture to the
transport as its `context`. Playwright sends a binary body with
`Content-Type: application/octet-stream` unless the call sets one.

```ts
import { test } from "@playwright/test";
import { c } from "@dlenroc/typed-client";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import { getUser } from "./users.js";

test("get user", async ({ request, baseURL }) => {
  const get = c.bind(getUser, playwrightTransport({ context: request, baseUrl: baseURL }));
  await get({ path: { id: 42 }, status: 200 });
});
```

Playwright binary bodies and multipart file data can be views into a larger
buffer. Pass the byte view itself (for example, `new Blob([bytes])`) to
use exactly the response bytes.

Without `baseUrl`, Playwright resolves relative templates under `use.baseURL`.
A `use.baseURL` without a final slash drops its last path segment, so
`https://api.example.test/v1` sends `/users/42` to
`https://api.example.test/users/42`. Pass `baseURL` as `baseUrl` to keep the
same [base URL](#base-url) rules as the other transports.

`@playwright/test` already brings in `playwright-core`. If TypeScript reports
that it cannot find `playwright-core` in the transport's declarations, install
`playwright-core@^1.62.0` directly.

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

Read parsed response cookies from `transport.cookies`.

See [Loading npm packages in k6](https://grafana.com/docs/k6/latest/using-k6/modules/#use-nodejs-modules).

## Custom transports

A `Transport` is a function. It takes one prepared `TransportRequest` and
returns a promise of a `TransportResponse`. Use the kind maps to describe what
it can send and decode. If a transport cannot handle a body kind of an
endpoint, TypeScript reports the incompatible endpoint at `c.bind`. Bind the
shared group to each transport and include platform-specific endpoints only
when the transport supports them.

```ts
import { c, type RequestKindMap, type Transport } from "@dlenroc/typed-client";

const empty: Transport<RequestKindMap, { none: undefined }> =
  async ({ url }) => ({
    url,
    status: 204,
    headers: {},
    read: async () => undefined,
  });

const endpoint = c.endpoint("/ping", { responses: { 204: c.none() } });
const ping = c.bind(endpoint, empty);
await ping();
```

See `TransportRequest` for the prepared fields and `TransportResponse` for the reader interface.

- Apply `request.url` by `request.reference`: for `path`, prefix it with your
  base URL; for `network`, prefix it with the scheme of your base URL; for
  `absolute`, send it as written.
- An error that a transport throws becomes a `ClientError` with the code
  `transport`, and the error is kept as `cause`.
- Release buffered resources in `read()`. This includes `read("none")`, which
  the client calls to skip decoding.
- For an unexpected status, the client calls `read("none")`.
- If resources can stay live after `read()`, for example a returned stream,
  implement `discard()`. The client calls it when a schema rejects the value
  that `read()` returned.
- The caller owns live resources that a successful call returns.
