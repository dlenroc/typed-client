import {
  binary,
  endpoint,
  json,
  kind,
  multipart,
  none,
  text,
  type,
  urlencoded,
} from "./core/endpoint.js";
import { bind } from "./core/bind.js";
import { raw } from "./core/raw.js";

export { ClientError } from "./core/errors.js";
export type { Raw } from "./core/raw.js";
export type {
  InferInput,
  InferResponse,
  Operation,
} from "./core/bind-types.js";
export type { BodyDeclaration, Endpoint, TypeHint } from "./core/endpoint-types.js";
export type {
  JsonValue,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./core/types.js";

export const c = {
  /**
   * Declare an HTTP endpoint with its request and response types.
   *
   * @defaultValue GET, with no request body.
   *
   * @remarks
   * Each `{name}` before `?` or `#` is a required path parameter. A
   * parameter can be part of a segment, for example `/files/{name}.json`
   * or `/jobs/{id}:cancel`. `{}` is literal text. The client escapes path
   * values with `encodeURIComponent`. If there are no declared responses,
   * pass `status` on each call.
   *
   * @example
   * ```ts
   * import { c } from "@dlenroc/typed-client";
   *
   * const createUser = c.endpoint("/users", {
   *   method: "POST",
   *   body: c.json<{ name: string }>(),
   *   responses: { 201: c.json<{ id: number }>(), 409: c.none() },
   * });
   * ```
   */
  endpoint,

  /**
   * Supply a type without runtime validation, for example for `path`,
   * `query`, or `headers`.
   *
   * @see {@link https://standardschema.dev/ | Standard Schema} for validation.
   */
  type,

  /**
   * A JSON body. A type argument gives the type without validation. A
   * schema validates and can transform it.
   *
   * @remarks
   * Without either, a request body is any value for `JSON.stringify` and is
   * optional, and a response body is the parsed JSON.
   *
   * @example
   * ```ts
   * c.json<User>();
   * c.json(UserSchema);
   * ```
   */
  json,

  /**
   * A text body. A type argument gives the type without validation. A
   * schema validates or transforms the string.
   */
  text,

  /**
   * A byte body. A request sends an `ArrayBuffer` or a view. A response
   * gives a `Uint8Array`.
   */
  binary,

  /**
   * A URL-encoded form body. A request sends a string or fields. A response
   * gives a record of strings. A type argument gives the type without
   * validation.
   */
  urlencoded,

  /**
   * A multipart form body. A request sends fields with text or file values.
   * A response gives a record of strings and files. A type argument gives
   * the type without validation.
   */
  multipart,

  /** No body. A request sends no body. A response body is discarded. */
  none,

  /**
   * A body kind of the bound transport, for example Fetch `blob` or
   * `stream`. A schema validates or transforms the value.
   */
  kind,

  /**
   * Bind an endpoint to get a callable function. Groups keep their keys.
   *
   * @remarks
   * Import a transport from `/fetch`, `/playwright`, or `/k6`.
   * See {@link Transport} to implement or wrap one.
   *
   * @example
   * ```ts
   * import { fetchTransport } from "@dlenroc/typed-client/fetch";
   *
   * const transport = fetchTransport({ baseUrl: "https://api.example.test" });
   * const create = c.bind(createUser, transport);
   * const { body } = await create({ body: { name: "Ada" }, status: 201 });
   * ```
   */
  bind,

  /**
   * Send one part of a call as given. The client skips the schema and the
   * encoding of that part. All other parts stay checked.
   *
   * @example
   * ```ts
   * await create({ body: c.raw("{broken"), status: 400 });
   * await get({ path: { id: c.raw("a/b") }, status: 404 });
   * await get({ path: c.raw("//host/x"), status: 200 });
   * ```
   */
  raw,
};
