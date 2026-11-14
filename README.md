# @dlenroc/typed-client

Declare typed HTTP endpoints and call them through Fetch, Playwright, or k6.

## Install

```sh
npm install @dlenroc/typed-client
```

The package uses ESM. Fetch works in Node.js 24+ and modern browsers.

## `c.endpoint(url, declaration?)`

`method` defaults to `GET`. A full `:name` path segment requires a matching
field in `path`, and its value is URL-escaped.

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
Both calls use `https://api.example.test/v1/users/42`.

## Bodies

Omitting the request body declaration allows optional JSON. Use `c.type<T>()`
or a schema to give callers a typed JSON body.

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

Use a kind such as `"text"` to select another representation,
`{ kind, schema }` to validate it, or `"none"` to forbid a request body.

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
returned stream when finished with it.

Omitting the body or passing `undefined` sends no body and skips the automatic
Content-Type header. JSON `null` is sent as a value. JSON serialization failures
raise a `request-prepare` error. Leave the body absent for Fetch `GET` and `HEAD`
requests.

### Fields, headers and files

Query, URL-encoded, and multipart fields accept records or arrays of
`[name, value]` pairs. Repeat a name in the pairs or use an array as a record
value. `undefined` omits a field and `null` sends an empty value. For a query
or URL-encoded body, you can also pass an encoded string or `URLSearchParams`.

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

File descriptors accept `data`, `filename?`, and `mediaType?`. The defaults are
`blob` and `application/octet-stream`. A binary view sends its selected byte
range. Fetch and Playwright accept `FormData` as the body. k6 accepts
`http.file()` values as fields.

Headers accept records, arrays of pairs, or `Headers`. Use records or pairs
for queries, forms, and headers shared across runtimes. `Headers` and
`URLSearchParams` require a compatible global constructor in the runtime.

Header names are case-insensitive. `undefined` allows a default value, `null`
suppresses the header and its default, and `""` sends an empty value. Use one
value per request header with Playwright and k6. With Playwright, leave
Content-Type enabled on requests with a body.

Checked multipart calls use the encoder's boundary. Use `unchecked: true`
to send a custom Content-Type in a negative test.

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

`InferResponse` includes the body and transport metadata. It defaults to
all declared statuses. Pass one status or a union to select results. For a
status-only endpoint, pass the status you expect.

## Call options and statuses

Request fields, call controls, and transport options share one object.

```ts
await api.users.get({
  path: { id: 42 },
  status: 200,
  signal: AbortSignal.timeout(5000),
});
```

| Option      | Behavior                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| `status`    | Accept one status or a nonempty array and narrow the result.               |
| `unchecked` | Skip request schemas and allow `method`, `path`, and `bodyKind` overrides. |
| `discard`   | Check status and headers, then discard the body before decoding.           |

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
    console.error(error.meta.operationId, error.status, error.expectedStatuses);
  }

  throw error;
}
```

| Code               | When it occurs                             | Additional fields           |
| ------------------ | ------------------------------------------ | --------------------------- |
| `request-input`    | The status list is empty                   |                             |
| `request-url`      | URL construction fails                     |                             |
| `request-prepare`  | The transport cannot prepare the request   |                             |
| `request-schema`   | A request schema reports issues or throws  | `field`, `reason`, `issues` |
| `transport`        | The transport call fails                   |                             |
| `status`           | The status falls outside the accepted set  | `expectedStatuses`          |
| `response-decode`  | The body cannot be decoded                 | `kind`                      |
| `response-schema`  | A response schema reports issues or throws | `field`, `reason`, `issues` |
| `response-cleanup` | Cleanup is the only failure                |                             |

Every `ClientError` includes `method` and `meta`. `url` is set when available.
Status, decoding, response schema, and cleanup errors also carry `status`
and raw `headers`. Schema errors include `issues` when `reason` is `"issues"`.

`cause` holds the underlying failure. If cleanup also fails,
`cleanupError` holds the secondary failure. Reporters that serialize errors
can read `code`, `meta`, and other enumerable diagnostics. Read
`message` and `cause` explicitly when building a JSON report.

## Other transports

### Playwright

Use Playwright 1.62 or later. Pass Playwright Test's `request` fixture to the
adapter as its context.

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
that it cannot find `playwright-core` in the adapter's declarations, install
`playwright-core@^1.62.0` directly. For a standalone script, install it to
import `request`, call `request.newContext()`, and dispose the context when
finished.

### k6

Use k6 2.2 or later. For TypeScript checking, add `@types/k6@^2.2.0` as a dev
dependency.

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
response handle. Use the kind maps to describe what it can send and decode.

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

Use the prepared request fields to send the request and `request.input` to
read transport-specific options. Release buffered resources in `read()`,
including when the client calls `read("none")` to skip decoding. Implement
`discard()` if resources can remain live after `read()`, such as when it
returns a stream. The client calls it when a status or schema check rejects
the response. The caller owns live resources returned by a successful call.
