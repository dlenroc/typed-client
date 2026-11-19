import { endpoint, type } from "./core/endpoint.js";
import { bind } from "./core/bind.js";

export { ClientError } from "./core/errors.js";
export type { InferInput, InferResponse } from "./core/bind-types.js";
export type {
  CommonOptions,
  Transport,
  TransportRequest,
  TransportResponse,
  RequestKindMap,
  ResponseKindMap,
  ResponseHeaders,
} from "./core/types.js";

export const c = {
  /**
   * Declare an HTTP endpoint with its request and response types.
   *
   * @defaultValue GET with an optional JSON body.
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
   *   body: c.type<{ name: string }>(),
   *   responses: { 201: c.type<{ id: number }>() },
   * });
   * ```
   */
  endpoint,

  /**
   * Supply a type without runtime validation. As a body declaration, it
   * selects JSON.
   *
   * @see {@link https://standardschema.dev/ | Standard Schema} for validation.
   */
  type,

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
};
