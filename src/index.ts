import { endpoint, type } from "./core/endpoint.js";
import { bind } from "./core/client.js";

export { ClientError } from "./core/errors.js";
export type { InferInput, InferResponse } from "./core/contract-types.js";
export type {
  Transport,
  TransportRequest,
  TransportResponse,
  RequestKindMap,
  ResponseKindMap,
  ResponseHeaders,
} from "./core/types.js";

export const c = {
  /**
   * Use a full `:name` segment for a required path parameter.
   *
   * @defaultValue GET with an optional JSON body.
   *
   * @remarks
   * Path values are URL-escaped.
   * With an empty or omitted response map, pass `status` on each call.
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
   * Supply a type without runtime validation. A bare body hint uses JSON.
   *
   * @see {@link https://standardschema.dev/ | Standard Schema} for validation.
   */
  type,

  /**
   * Bind an endpoint to get a callable function. Groups keep their keys.
   *
   * @remarks
   * Import an adapter from `/fetch`, `/playwright`, or `/k6`.
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
