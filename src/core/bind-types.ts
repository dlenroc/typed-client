import type {
  Defined,
  Endpoint,
  HttpMethod,
  IsRequestValue,
  KindInput,
  NormalizedBody,
  NormalizedResponse,
  PathPlan,
  PathScalar,
  ResponseSchemaCheck,
  SchemaInput,
  SchemaLike,
  SchemaOutput,
} from "./endpoint-types.js";
import type {
  AnyTransport,
  CoreOptions,
  HeaderInput,
  QueryInput,
  RequestFields,
  ResponseHeaders,
  TransportRequest,
  TransportResponse,
} from "./types.js";

type RequestKinds<Adapter> =
  Adapter extends (request: TransportRequest<infer Requests, any, any>) => unknown
    ? Requests
    : never;

type ResponseKinds<Adapter> =
  Adapter extends (request: TransportRequest<any, infer Responses, any>) => unknown
    ? Responses
    : never;

type NativeOptions<Adapter> =
  Adapter extends (request: TransportRequest<any, any, infer Options>) => unknown
    ? Options
    : never;

type TransportMetadata<Adapter extends AnyTransport> =
  Adapter extends (...args: never[]) => Promise<{ readonly transport?: infer Metadata }>
    ? Metadata
    : never;

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};
type FieldProperty<Key extends string, Value> = undefined extends Value
  ? { [Property in Key]?: Value }
  : { [Property in Key]: Value };

type KeysOfPath<Path extends PathPlan> = Path extends {
  readonly names: readonly (infer Name extends string)[];
}
  ? Name
  : never;

type PathProperty<Spec extends Endpoint> = [Defined<Spec["pathSchema"]>] extends [never]
  ? [KeysOfPath<Spec["path"]>] extends [never]
    ? {}
    : string extends KeysOfPath<Spec["path"]>
      ? { readonly path?: Readonly<Record<string, PathScalar>> }
      : { readonly path: Readonly<Record<KeysOfPath<Spec["path"]>, PathScalar>> }
  : FieldProperty<"path", SchemaInput<Defined<Spec["pathSchema"]>>>;

type SchemaOrInput<Schema, Raw> = [Defined<Schema>] extends [never]
  ? Raw
  : SchemaInput<Defined<Schema>>;

type TransportBody<
  Kind extends string,
  Adapter extends AnyTransport,
> = Kind extends keyof RequestKinds<Adapter> ? RequestKinds<Adapter>[Kind] : KindInput<Kind>;

type RequestBodyInput<Body extends NormalizedBody, Adapter extends AnyTransport> = [
  Defined<Body["schema"]>,
] extends [never]
  ? Body["kind"] extends "json"
    ? TransportBody<Body["kind"], Adapter> | undefined
    : TransportBody<Body["kind"], Adapter>
  : SchemaInput<Defined<Body["schema"]>>;

// A call must work for every possible declaration chosen at runtime.
type CommonInput<Branches> = [Branches] extends [(value: infer Input) => void] ? Input : never;

type RequestBodyInputs<Body extends NormalizedBody, Adapter extends AnyTransport> =
  Body extends unknown ? (value: RequestBodyInput<Body, Adapter>) => void : never;

type UncheckedBodyInputs<Kind extends string, Adapter extends AnyTransport> = Kind extends unknown
  ? (value: TransportBody<Kind, Adapter>) => void
  : never;

type RequestFor<Spec extends Endpoint, Adapter extends AnyTransport> = Simplify<
  PathProperty<Spec> &
    FieldProperty<"query", SchemaOrInput<Spec["querySchema"], QueryInput | undefined>> &
    FieldProperty<"headers", SchemaOrInput<Spec["headersSchema"], HeaderInput | undefined>> &
    FieldProperty<"body", CommonInput<RequestBodyInputs<Spec["body"], Adapter>>>
>;

type UncheckedPath<Spec extends Endpoint> =
  string extends KeysOfPath<Spec["path"]>
    ? { readonly path?: string | Readonly<Record<string, PathScalar>> }
    : [KeysOfPath<Spec["path"]>] extends [never]
      ? { readonly path?: string | Readonly<Record<string, PathScalar>> }
      : { readonly path: string | Readonly<Record<KeysOfPath<Spec["path"]>, PathScalar>> };

type UncheckedRequestFor<Spec extends Endpoint, Adapter extends AnyTransport> = {
  readonly method?: HttpMethod;
  readonly query?: QueryInput;
  readonly headers?: HeaderInput;
} & UncheckedPath<Spec> &
  (
    | {
        readonly bodyKind?: undefined;
        readonly body?: CommonInput<UncheckedBodyInputs<Spec["body"]["kind"], Adapter>> | undefined;
      }
    | {
        [Kind in keyof RequestKinds<Adapter> & string]: {
          readonly bodyKind: Kind;
          readonly body?: RequestKinds<Adapter>[Kind] | undefined;
        };
      }[keyof RequestKinds<Adapter> & string]
  );

type CallOptions<Spec extends Endpoint, Adapter extends AnyTransport> = CoreOptions<
  DeclaredStatuses<Spec> | (number & {})
> &
  NativeOptions<Adapter>;

type ValidOptions<Spec extends Endpoint, Options> = (
  keyof Spec["responses"] extends never ? { readonly status: number | readonly number[] } : unknown
) &
  (Options extends { readonly status: readonly [] } ? never : unknown);

// An omitted key in any union member contributes the default behavior.
type OptionValue<Options, Key extends keyof CoreOptions> = Options extends unknown
  ? Key extends keyof Options
    ? Options[Key]
    : undefined
  : never;

type CallRequest<Spec extends Endpoint, Adapter extends AnyTransport, Unchecked> =
  [Unchecked] extends [true]
    ? UncheckedRequestFor<Spec, Adapter>
    : true extends Unchecked
      ? RequestFor<Spec, Adapter> & UncheckedRequestFor<Spec, Adapter>
      : RequestFor<Spec, Adapter>;

type CallKeys<Fields> = Fields extends unknown ? keyof Fields : never;

type CallFields<Spec extends Endpoint, Adapter extends AnyTransport, Input> =
  CallOptions<Spec, Adapter> &
  CallRequest<Spec, Adapter, OptionValue<Input, "unchecked">> &
  ValidOptions<Spec, Input>;

// Mapping over Input preserves contextual typing of transport callbacks.
type CheckCallKeys<Input, Fields> = {
  [Key in keyof Input]: Key extends CallKeys<Fields> ? unknown : never;
};

type StatusNumber<Status> = Status extends number
  ? Status
  : Status extends `${infer Code extends number}`
    ? Code
    : never;

type DeclaredStatuses<Spec extends Endpoint> = StatusNumber<keyof Spec["responses"]>;

type ExpectedStatuses<Expectation> = Expectation extends number
  ? Expectation
  : Expectation extends readonly number[]
    ? Expectation[number]
    : never;

type ResultStatuses<Spec extends Endpoint, Options> =
  | ExpectedStatuses<OptionValue<Options, "status">>
  | (undefined extends OptionValue<Options, "status"> ? DeclaredStatuses<Spec> : never);

type ResponseAt<
  Spec extends Endpoint,
  Status extends number,
> = Status extends keyof Spec["responses"]
  ? Spec["responses"][Status]
  : `${Status}` extends keyof Spec["responses"]
    ? Spec["responses"][`${Status}`]
    : undefined;

type DecodedBody<Response, Adapter extends AnyTransport> = Response extends {
  readonly kind: infer Kind extends string;
  readonly bodySchema: infer Schema;
}
  ? [Defined<Schema>] extends [never]
    ? Kind extends keyof ResponseKinds<Adapter>
      ? ResponseKinds<Adapter>[Kind]
      : never
    : SchemaOutput<Defined<Schema>>
  : undefined;

type FinalHeaders<Response> = Response extends { readonly headersSchema: infer Schema }
  ? [Defined<Schema>] extends [never]
    ? ResponseHeaders
    : SchemaOutput<Defined<Schema>>
  : ResponseHeaders;

type MaybeDiscard<Options, Body> = [OptionValue<Options, "discard">] extends [true]
  ? undefined
  : true extends OptionValue<Options, "discard">
    ? Body | undefined
    : Body;

type TransportField<Adapter extends AnyTransport> = [TransportMetadata<Adapter>] extends [never]
  ? {}
  : {
      /**
       * For example, Fetch `redirected`, Playwright `serverAddr`, or k6
       * `timings`.
       */
      readonly transport?: TransportMetadata<Adapter>;
    };

type ResponseCase<Status extends number, Response, Adapter extends AnyTransport, Options> =
  Simplify<{
    readonly status: Status;

    /** The final response URL, after redirects. */
    readonly url: string;

    /** Raw headers, or the output of the response headers schema. */
    readonly headers: FinalHeaders<Response>;

    /** The decoded body, or the output of the response body schema. */
    readonly body: MaybeDiscard<Options, DecodedBody<Response, Adapter>>;
  } & TransportField<Adapter>>;

type ResponseFor<
  Spec extends Endpoint,
  Adapter extends AnyTransport,
  Status extends number,
  Options = {},
> = number extends Status
  ? ResponseCase<number, ResponseAt<Spec, DeclaredStatuses<Spec>> | undefined, Adapter, Options>
  : Status extends number
    ? ResponseCase<Status, ResponseAt<Spec, Status>, Adapter, Options>
    : never;

type ResultFor<Spec extends Endpoint, Adapter extends AnyTransport, Options> =
  ResponseFor<Spec, Adapter, ResultStatuses<Spec, Options>, Options>;

declare const boundOperation: unique symbol;

interface OperationTypes<
  Spec extends Endpoint = Endpoint,
  Adapter extends AnyTransport = AnyTransport,
> {
  readonly [boundOperation]: { readonly spec: Spec; readonly adapter: Adapter };
}

/**
 * The input type of a checked call to a bound endpoint. Includes the
 * native options of the bound transport.
 *
 * @example
 * ```ts
 * const input = {
 *   path: { id: 42 },
 * } satisfies InferInput<typeof getUser>;
 * ```
 */
export type InferInput<Operation extends OperationTypes> = Simplify<
  CallFields<
    Operation[typeof boundOperation]["spec"],
    Operation[typeof boundOperation]["adapter"],
    {}
  > & { readonly unchecked?: false }
>;

/**
 * The result type of a call to a bound endpoint. Pass a status or union
 * of statuses. Defaults to all declared statuses. If there are no declared
 * responses, pass a status. Accepted undeclared statuses return raw
 * headers and `body: undefined`.
 *
 * @example
 * ```ts
 * type Result = InferResponse<typeof getUser, 200 | 404>;
 * ```
 */
export type InferResponse<
  Operation extends OperationTypes,
  Status extends number = DeclaredStatuses<Operation[typeof boundOperation]["spec"]>,
> = ResponseFor<
  Operation[typeof boundOperation]["spec"],
  Operation[typeof boundOperation]["adapter"],
  Status
>;

type BoundOperation<Spec extends Endpoint, Adapter extends AnyTransport> = (
  {} extends CallFields<Spec, Adapter, {}>
    ? {
        /**
         * Send the request and return the checked response. Accepts all
         * declared statuses.
         *
         * @throws
         * A {@link ClientError} if the call fails, including an unexpected
         * status.
         */
        (input?: undefined): Promise<ResultFor<Spec, Adapter, {}>>;
      }
    : {}
) & OperationTypes<Spec, Adapter> & {
  // Infer the flag before checking required fields so completions use it.
  /**
   * Send the request and return the checked response. Accepts all declared
   * statuses by default. Pass `status` to select which statuses to accept
   * and narrow the result.
   *
   * @remarks
   * Use `unchecked: true` to skip request schemas and allow `method`,
   * `path`, and `bodyKind` overrides. Use `discard: true` to check status
   * and headers, then discard the body before decoding.
   *
   * @throws
   * A {@link ClientError} if the call fails, including an unexpected
   * status.
   *
   * @example
   * ```ts
   * const result = await getUser({ path: { id: 42 }, status: 200 });
   * ```
   *
   * @example Send malformed JSON and accept HTTP 400.
   * ```ts
   * await create({
   *   unchecked: true,
   *   bodyKind: "text",
   *   body: "{broken",
   *   headers: { "content-type": "application/json" },
   *   status: 400,
   * });
   * ```
   */
  <const Input, const Unchecked extends boolean | undefined = undefined>(
    input: Input &
      CallOptions<Spec, Adapter> &
      { readonly unchecked?: Unchecked } &
      ([Unchecked] extends [true] ? { readonly unchecked: true } : unknown) &
      CallRequest<Spec, Adapter, Unchecked> &
      NoInfer<ValidOptions<Spec, Input>> &
      CheckCallKeys<Input, CallFields<Spec, Adapter, Input>>,
  ): Promise<ResultFor<Spec, Adapter, Input>>;

  /**
   * Send the request and return the checked response. Accepts all declared
   * statuses by default. Pass `status` to select which statuses to accept
   * and narrow the result.
   *
   * @throws
   * A {@link ClientError} if the call fails, including an unexpected
   * status.
   */
  <const Input extends CallOptions<Spec, Adapter> & RequestFields>(
    input: Input &
      NoInfer<
        CallRequest<Spec, Adapter, OptionValue<Input, "unchecked">> & ValidOptions<Spec, Input>
      > &
      CheckCallKeys<Input, CallFields<Spec, Adapter, Input>>,
  ): Promise<ResultFor<Spec, Adapter, Input>>;
};

type InvalidRequestBody<
  Body extends NormalizedBody,
  Adapter extends AnyTransport,
> = Body extends unknown
  ? Body["kind"] extends keyof RequestKinds<Adapter>
    ? [Defined<Body["schema"]>] extends [never]
      ? never
      : IsRequestValue<
            SchemaOutput<Defined<Body["schema"]>>,
            RequestKinds<Adapter>[Body["kind"]]
          > extends true
        ? never
        : Body
    : Body
  : never;

type InvalidResponseSchema<Schema, Wire> = Schema extends SchemaLike
  ? [ResponseSchemaCheck<Schema, Wire>] extends [never]
    ? Schema
    : never
  : never;

type InvalidResponse<Response, Adapter extends AnyTransport> = Response extends NormalizedResponse
  ? Response["kind"] extends keyof ResponseKinds<Adapter>
    ? InvalidResponseSchema<Response["bodySchema"], ResponseKinds<Adapter>[Response["kind"]]>
    : Response
  : Response;

type BindingCompatible<Spec extends Endpoint, Adapter extends AnyTransport> = [
  | InvalidRequestBody<Spec["body"], Adapter>
  | InvalidResponse<Spec["responses"][keyof Spec["responses"]], Adapter>,
] extends [never]
  ? unknown
  : never;

type ValidateEndpoints<Contract, Adapter extends AnyTransport> = Contract extends Endpoint
  ? BindingCompatible<Contract, Adapter>
  : Contract extends object
    ? { readonly [Key in keyof Contract]: ValidateEndpoints<Contract[Key], Adapter> }
    : never;

export type ValidateBinding<Contract, Adapter extends AnyTransport> = Adapter extends unknown
  ? Awaited<ReturnType<Adapter>> extends TransportResponse<ResponseKinds<Adapter>, object>
    ? ValidateEndpoints<Contract, Adapter>
    : never
  : never;

export type BoundContract<Contract, Adapter extends AnyTransport> = Contract extends Endpoint
  ? BoundOperation<Contract, Adapter>
  : Contract extends object
    ? { readonly [Key in keyof Contract]: BoundContract<Contract[Key], Adapter> }
    : never;

export type EndpointTree = Endpoint | Readonly<Record<string, unknown>>;
