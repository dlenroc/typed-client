import type { KindPairs, Raw } from "./raw.js";
import type {
  AcceptsUndefined,
  Defined,
  Endpoint,
  HttpMethod,
  IsAny,
  IsRequestValue,
  KindInput,
  NormalizedBody,
  NormalizedResponse,
  PathScalar,
  ResponseSchemaCheck,
  SchemaInput,
  SchemaLike,
  SchemaOutput,
  TypeHint,
} from "./endpoint-types.js";
import type {
  AnyTransport,
  HeaderInput,
  QueryInput,
  NativeFormData,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  Transport,
  TransportRequest,
} from "./types.js";

export interface CoreOptions<Status extends number = number> {
  /**
   * A status array must be nonempty. Accepted undeclared statuses return
   * raw headers and `body: undefined`.
   *
   * @defaultValue All declared response statuses
   */
  readonly status?: Status | readonly Status[];

  /**
   * Check status and headers, then discard the body before decoding.
   *
   * @defaultValue false
   */
  readonly discard?: boolean;
}

/** Call options that each transport applies if it can. */
interface CommonOptions {
  /**
   * Milliseconds to wait for the response.
   *
   * @defaultValue k6: 60 s, Playwright: 30 s
   */
  readonly timeout?: number;

  /**
   * Follow redirects and return the final response.
   *
   * @defaultValue false
   */
  readonly follow?: boolean;
}

// A portable operation can call a bound transport without native options.
// The optional mark distinguishes this view from an explicitly supplied adapter.
declare const portable: unique symbol;
type PortableTransport = (
  | Transport<any, {}, {}, object>
  | Transport<any, {}, {}>
) & { readonly [portable]?: never };

type IsPortable<Adapter> =
  IsAny<Adapter> extends true ? false : typeof portable extends keyof Adapter ? true : false;

type PortableRequests = Omit<RequestKindMap, "multipart"> & {
  readonly multipart: Exclude<RequestKindMap["multipart"], NativeFormData>;
} & Record<string, unknown>;

type RequestKinds<Adapter> =
  IsPortable<Adapter> extends true
    ? PortableRequests
    : Adapter extends (request: TransportRequest<infer Requests, any, any>) => unknown
      ? Requests
      : never;

type ResponseKinds<Adapter> =
  IsPortable<Adapter> extends true
    ? ResponseKindMap & Record<string, unknown>
    : Adapter extends (request: TransportRequest<any, infer Responses, any>) => unknown
      ? Responses
      : never;

type NativeOptions<Adapter> = CommonInput<
  Adapter extends (request: TransportRequest<any, any, infer Options>) => unknown
    ? (options: Options) => void
    : never
>;

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

type FieldProperty<Key extends string, Value, Optional> =
  Optional extends true ? { [Property in Key]?: Value } : { [Property in Key]: Value };

// A runtime choice of schema needs an input each alternative accepts.
// Distribute over schemas so one schema can still accept a union of inputs.
type SharedSchemaInput<Schema> = CommonInput<
  Schema extends unknown ? (input: SchemaInput<Schema>) => void : never
>;

// A type hint with only optional keys can be omitted. A validator receives
// the omitted value as undefined, so its own input must allow that value.
type RecordOptional<Schema> =
  Schema extends TypeHint<infer Hint>
    ? {} extends Hint ? true : AcceptsUndefined<Hint>
    : AcceptsUndefined<SchemaInput<Schema>>;

type RecordProperty<Key extends string, Schema, Value> = FieldProperty<
  Key,
  Value,
  false extends RecordOptional<Defined<Schema>> ? false : true
>;

type KeysOfPath<Spec extends Endpoint> = Spec["params"][number];

// `Mode` is true for a call. It is false for `InferInput`, which has no raw
// values.
type RawOf<Mode, Value> =
  Mode extends true ? Raw<readonly [Value, undefined]> : never;

type PathProperty<Spec extends Endpoint, Mode> =
  [Defined<Spec["request"]["path"]>] extends [never]
    ? [KeysOfPath<Spec>] extends [never]
      ? Mode extends true
        ? { readonly path?: RawOf<Mode, string> }
        : {}
      : string extends KeysOfPath<Spec>
        ? {
            readonly path?:
              | Readonly<Record<string, PathScalar | RawOf<Mode, string>>>
              | RawOf<Mode, string>;
          }
        : {
            readonly path:
              | Readonly<Record<KeysOfPath<Spec>, PathScalar | RawOf<Mode, string>>>
              | RawOf<Mode, string>;
          }
    : FieldProperty<
        "path",
        SharedSchemaInput<Defined<Spec["request"]["path"]>> | RawOf<Mode, string>,
        AcceptsUndefined<SharedSchemaInput<Defined<Spec["request"]["path"]>>>
      >;

type FieldInput<Schema, Wire> =
  [Defined<Schema>] extends [never]
    ? Wire
    : SharedSchemaInput<Defined<Schema>>;

// A raw body names a kind of the transport, or uses the declared kind.
type RawBodyPairs<Kind extends string, Adapter extends AnyTransport> =
  | KindPairs<{
      [WireKind in keyof RequestKinds<Adapter> & string]: TransportBody<WireKind, Adapter>;
    }>
  | readonly [CommonInput<RawBodyInputs<Kind, Adapter>>, undefined];

type RawBody<Body extends NormalizedBody, Adapter extends AnyTransport, Mode> =
  IsPortable<Adapter> extends true
    ? never
    : Mode extends true ? Raw<RawBodyPairs<Body["kind"], Adapter>> : never;

type TransportBody<Kind extends string, Adapter extends AnyTransport> =
  CommonInput<
    Adapter extends unknown
      ? (value: Kind extends keyof RequestKinds<Adapter>
          ? RequestKinds<Adapter>[Kind]
          : KindInput<Kind>) => void
      : never
  >;

type RequestBodyInput<Body extends NormalizedBody, Adapter extends AnyTransport> =
  [Defined<Body["schema"]>] extends [never]
    ? Body["kind"] extends "json"
      ? TransportBody<Body["kind"], Adapter> | undefined
      : TransportBody<Body["kind"], Adapter>
    : SharedSchemaInput<Defined<Body["schema"]>>;

// A body without a schema is optional for the kinds `json` and `none`.
type BodyBranchOptional<Body extends NormalizedBody, Adapter extends AnyTransport> =
  [Defined<Body["schema"]>] extends [never]
    ? Body["kind"] extends "json" | "none"
      ? true
      : AcceptsUndefined<TransportBody<Body["kind"], Adapter>>
    : AcceptsUndefined<SharedSchemaInput<Defined<Body["schema"]>>>;

// Every possible declaration must accept an omitted body.
type BodyOptional<Body extends NormalizedBody, Adapter extends AnyTransport> =
  false extends (Body extends unknown ? BodyBranchOptional<Body, Adapter> : never)
    ? false
    : true;

// A call must work for every possible declaration chosen at runtime.
type CommonInput<Branches> =
  [Branches] extends [(value: infer Input) => void] ? Input : never;

type RequestBodyInputs<Body extends NormalizedBody, Adapter extends AnyTransport> =
  Body extends unknown ? (value: RequestBodyInput<Body, Adapter>) => void : never;

// A raw string at a JSON body is sent using the transport's text kind.
type NonString = object | number | bigint | boolean | symbol | null | undefined;

type RawBodyInputs<Kind extends string, Adapter extends AnyTransport> =
  Kind extends "json"
    ? (value:
        | (TransportBody<Kind, Adapter> & NonString)
        | ("text" extends keyof RequestKinds<Adapter>
            ? string & TransportBody<"text", Adapter>
            : never)) => void
    : (value: TransportBody<Kind, Adapter>) => void;

// In a call, `unknown` is written as a union. Then the raw values stay in the
// type, and the position gives its kinds to `c.raw`.
type AnyValue<Value, Mode> =
  Mode extends true ? (unknown extends Value ? {} | null | undefined : Value) : Value;

type RequestFor<Spec extends Endpoint, Adapter extends AnyTransport, Mode = true> =
  Simplify<
    PathProperty<Spec, Mode> &
      RecordProperty<
        "query",
        Spec["request"]["query"],
        | FieldInput<Spec["request"]["query"], QueryInput | undefined>
        | RawOf<Mode, QueryInput>
      > &
      RecordProperty<
        "headers",
        Spec["request"]["headers"],
        | FieldInput<Spec["request"]["headers"], HeaderInput | undefined>
        | RawOf<Mode, HeaderInput>
      > &
      (Mode extends true
        ? FieldProperty<
            "body",
            | AnyValue<CommonInput<RequestBodyInputs<Spec["request"]["body"], Adapter>>, Mode>
            | RawBody<Spec["request"]["body"], Adapter, Mode>,
            BodyOptional<Spec["request"]["body"], Adapter>
          >
        : Spec["request"]["body"] extends { readonly kind: "none"; readonly schema: undefined }
          ? {}
          : FieldProperty<
              "body",
              CommonInput<RequestBodyInputs<Spec["request"]["body"], Adapter>>,
              BodyOptional<Spec["request"]["body"], Adapter>
            >) &
      (Mode extends true
        ? {
            /** Only a raw value. It replaces the method of the endpoint. */
            readonly method?: RawOf<true, HttpMethod>;
          }
        : {})
  >;

type TransportOption<Options> =
  IsAny<Options> extends true
    ? { readonly transport?: any }
    : {} extends Options
      ? {
          /** Options of the bound transport. */
          readonly transport?: Options;
        }
      : {
          /** Options of the bound transport. */
          readonly transport: Options;
        };

type CallOptions<Spec extends Endpoint, Adapter extends AnyTransport> =
  CoreOptions<DeclaredStatuses<Spec> | (number & {})> &
    CommonOptions &
    (IsPortable<Adapter> extends true
      ? { readonly transport?: never }
      : TransportOption<NativeOptions<Adapter>>);

type ValidOptions<Spec extends Endpoint, Options> =
  (keyof Spec["responses"] extends never
    ? { readonly status: number | readonly number[] }
    : unknown) &
    (Options extends { readonly status: readonly [] }
      ? { readonly status: readonly [number, ...number[]] }
      : unknown);

declare const absent: unique symbol;

// An option that the call leaves out or may leave out.
type Absent = { readonly [absent]: true };

type MayOmit<Value> =
  Absent extends Value ? true : AcceptsUndefined<Value>;

// An omitted key in any union member contributes the default behavior.
type OptionValue<Options, Key extends keyof CoreOptions> =
  Options extends unknown
    ? Key extends keyof Options
      ? {} extends Pick<Options, Key>
        ? Options[Key] | Absent
        : Options[Key]
      : Absent
    : never;

type CallFields<
  Spec extends Endpoint,
  Adapter extends AnyTransport,
  Input,
  Mode = true,
> = CallOptions<Spec, Adapter> &
  RequestFor<Spec, Adapter, Mode> &
  ValidOptions<Spec, Input>;



type StatusNumber<Status> =
  Status extends number
    ? Status
    : Status extends `${infer Code extends number}`
      ? Code
      : never;

type DeclaredStatuses<Spec extends Endpoint> = StatusNumber<keyof Spec["responses"]>;

type ExpectedStatuses<Expectation> =
  Expectation extends number
    ? Expectation
    : Expectation extends readonly number[]
      ? Expectation[number]
      : never;

type ResultStatuses<Spec extends Endpoint, Options> =
  | ExpectedStatuses<OptionValue<Options, "status">>
  | (MayOmit<OptionValue<Options, "status">> extends true ? DeclaredStatuses<Spec> : never);

type ResponseAt<Spec extends Endpoint, Status extends number> =
  Status extends keyof Spec["responses"]
    ? Spec["responses"][Status]
    : `${Status}` extends keyof Spec["responses"]
      ? Spec["responses"][`${Status}`]
      : undefined;

type DecodedBody<Response, Adapter extends AnyTransport> =
  Response extends {
    readonly body: {
      readonly kind: infer Kind extends string;
      readonly schema: infer Schema;
    };
  }
    ? [Defined<Schema>] extends [never]
      ? Kind extends keyof ResponseKinds<Adapter>
        ? ResponseKinds<Adapter>[Kind]
        : never
      : SchemaOutput<Defined<Schema>>
    : undefined;

type FinalHeaders<Response> =
  Response extends { readonly headers: infer Schema }
    ? [Defined<Schema>] extends [never]
      ? ResponseHeaders
      : [Defined<Schema>] extends [TypeHint<infer Hint>]
        ? ResponseHeaders & Hint
        : SchemaOutput<Defined<Schema>>
    : ResponseHeaders;

type MaybeDiscard<Options, Body> = DiscardBody<OptionValue<Options, "discard">, Body>;

type DiscardBody<Value, Body> =
  [Exclude<Value, Absent | undefined>] extends [never]
    ? Body
    : [Exclude<Value, Absent | undefined>] extends [true]
      ? MayOmit<Value> extends true
        ? Body | undefined
        : undefined
      : true extends Value
        ? Body | undefined
        : Body;

// Without metadata, a transport gives `undefined`.
type ResultMetadata<Response> = Response extends { readonly transport?: unknown }
  ? Response["transport"]
  : undefined;

type ResponseFor<
  Spec extends Endpoint,
  Adapter extends AnyTransport,
  Status extends number,
  Options = {},
> = Status extends unknown
  ? (
      number extends Status
        ? ResponseAt<Spec, DeclaredStatuses<Spec>> | undefined
        : ResponseAt<Spec, Status> | (number extends DeclaredStatuses<Spec> ? undefined : never)
    ) extends infer Response
    ? {
        readonly status: Status;

        /** The final response URL, after redirects. */
        readonly url: string;

        /** Raw headers, or the output of the response headers schema. */
        readonly headers: FinalHeaders<Response>;

        /** The decoded body, or the output of the response body schema. */
        readonly body: MaybeDiscard<Options, DecodedBody<Response, Adapter>>;

        /**
         * For example, Fetch `redirected`, Playwright `serverAddr`, or k6
         * `timings`.
         */
        readonly transport: ResultMetadata<Awaited<ReturnType<Adapter>>>;
      }
    : never
  : never;

declare const boundOperation: unique symbol;

interface OperationTypes<
  Spec extends Endpoint = Endpoint,
  Adapter extends AnyTransport = AnyTransport,
> {
  readonly [boundOperation]: { readonly spec: Spec; readonly adapter: Adapter };
}

// In an unbound declaration, standard body kinds have their portable wire
// types. An unchecked custom kind acquires a concrete type only at bind.
type ContractTransport = Transport<
  RequestKindMap & Record<string, unknown>,
  ResponseKindMap & Record<string, unknown>
>;

/**
 * The input of an endpoint or bound call, without raw values. A bound
 * call also includes its transport options.
 *
 * @example
 * ```ts
 * const input = { path: { id: 42 } } satisfies InferInput<typeof getUser>;
 * ```
 */
export type InferInput<Target extends Endpoint | OperationTypes> =
  Target extends Endpoint
    ? Omit<CallFields<Target, ContractTransport, {}, false>, "transport">
    : Target extends OperationTypes<infer Spec, infer Adapter>
      ? Simplify<CallFields<Spec, Adapter, {}, false>>
      : never;

type WithoutTransport<Result> = Result extends unknown ? Omit<Result, "transport"> : never;

type InferredStatuses<Spec extends Endpoint, Status> =
  Status extends number ? Status : DeclaredStatuses<Spec>;

/**
 * The result of an endpoint or bound call, narrowed to the specified
 * status or union of statuses. Defaults to all declared statuses.
 * A bound call includes its transport metadata. Accepted undeclared
 * statuses have raw headers and an undefined body.
 *
 * @example
 * ```ts
 * type User = InferResponse<typeof getUser, 200>["body"];
 * ```
 */
export type InferResponse<
  Target extends Endpoint | OperationTypes,
  Status extends number | Absent = Absent,
> = Target extends Endpoint
  ? WithoutTransport<ResponseFor<Target, ContractTransport, InferredStatuses<Target, Status>>>
  : Target extends OperationTypes<infer Spec, infer Adapter>
    ? ResponseFor<Spec, Adapter, InferredStatuses<Spec, Status>>
    : never;

type InputArgs<Spec extends Endpoint, Adapter extends AnyTransport, Value> =
  {} extends CallFields<Spec, Adapter, {}> ? [input?: Value | undefined] : [input: Value];

// An unknown JSON input accepts any ordinary value. Check raw values
// separately so that unknown cannot hide an unsupported transport kind.
type CheckRawBody<Input, Allowed> =
  Input extends { readonly body?: infer Body }
    ? [Extract<Body, Raw>] extends [Allowed] ? unknown : { readonly body?: Allowed }
    : unknown;

// Explicit type arguments must agree with the actual status and discard.
type CheckedArgument<Spec extends Endpoint, Adapter extends AnyTransport, Input> =
  Input extends undefined
    ? undefined
    : CallFields<Spec, Adapter, Input> &
      CheckRawBody<Input, RawBody<Spec["request"]["body"], Adapter, true>> &
      Pick<Input, Extract<keyof Input, keyof CoreOptions>> &
      Partial<Record<Exclude<keyof CoreOptions, keyof Input>, never>>;

// Compare inputs contravariantly even without strictFunctionTypes. Compare
// results by declared status: a wider body at one status must not hide in
// the union of bodies returned at other statuses.
type SupportsPortableCall<Spec extends Endpoint, Adapter extends AnyTransport> =
  IsAny<Adapter> extends true ? boolean
    : IsPortable<Adapter> extends true ? true
    : {} extends NativeOptions<Adapter>
      ? [
          RequestFor<Spec, PortableTransport, false>,
          ResponseFor<Spec, Adapter, DeclaredStatuses<Spec>>,
        ] extends [
          RequestFor<Spec, Adapter, false>,
          ResponseFor<Spec, PortableTransport, DeclaredStatuses<Spec>>,
        ] ? true : boolean
      : boolean;

/**
 * A bound endpoint. Use `Operation<typeof endpoint>` for a helper that
 * sends portable inputs. Supply the adapter type to use its native options,
 * raw body kinds and metadata. Without type arguments, any operation matches.
 */
export interface Operation<
  Spec extends Endpoint = any,
  Adapter extends AnyTransport = IsAny<Spec> extends true ? any : PortableTransport,
> extends OperationTypes<Spec, Adapter> {
  readonly [portable]: SupportsPortableCall<Spec, Adapter>;

  /**
   * Send the request and return the checked response. Accepts all
   * declared statuses by default. Pass `status` to select which statuses
   * to accept and narrow the result.
   *
   * @remarks
   * Use `c.raw(value)` on one part to send it as given. Use
   * `discard: true` to check status and headers, then discard the body
   * before decoding.
   *
   * @throws
   * A {@link ClientError} if the call fails, including an unexpected
   * status.
   *
   * @example
   * ```ts
   * const result = await getUser({ path: { id: 42 }, status: 200 });
   * ```
   */
  <
    const Args extends InputArgs<Spec, Adapter, CallOptions<Spec, Adapter> & RequestFor<Spec, Adapter>>,
  >(
    // Infer the tuple to distinguish no argument from a possibly omitted input.
    // Check against the concrete fields for nested completions and excess-key errors.
    ...input: [Args] extends [never]
      ? Args
      : { [Index in keyof Args]: CheckedArgument<Spec, Adapter, Args[Index]> }
  ): Promise<ResponseFor<Spec, Adapter, ResultStatuses<Spec, Args[0]>, Args[0]>>;
}

type InvalidRequestBody<Body extends NormalizedBody, Adapter extends AnyTransport> =
  Body extends unknown
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

type InvalidResponseSchema<Schema, Wire> =
  [Schema] extends [undefined]
    ? never
    : Schema extends SchemaLike
    ? [ResponseSchemaCheck<Schema, Wire>] extends [never]
      ? Schema
      : never
    : never;

type InvalidResponse<Response, Adapter extends AnyTransport> =
  Response extends NormalizedResponse
    ? Response["body"]["kind"] extends keyof ResponseKinds<Adapter>
      ? InvalidResponseSchema<
          Response["body"]["schema"],
          ResponseKinds<Adapter>[Response["body"]["kind"]]
        >
      : Response
    : Response;

type BindingCompatible<Spec extends Endpoint, Adapter extends AnyTransport> =
  [
    | InvalidRequestBody<Spec["request"]["body"], Adapter>
    | InvalidResponse<Spec["responses"][keyof Spec["responses"]], Adapter>,
  ] extends [never]
    ? unknown
    : never;

type UnsupportedKind<Spec extends Endpoint, Adapter extends AnyTransport> =
  | Exclude<Spec["request"]["body"]["kind"], keyof RequestKinds<Adapter>>
  | (Spec["responses"][keyof Spec["responses"]] extends infer Response
      ? Response extends { readonly body: { readonly kind: infer Kind extends string } }
        ? Exclude<Kind, keyof ResponseKinds<Adapter>>
        : never
      : never);

// Distribute over adapters so a union is accepted only if every adapter works.
type EndpointBindingError<Spec extends Endpoint, Adapter extends AnyTransport, Name extends string> =
  Adapter extends unknown
    ? [UnsupportedKind<Spec, Adapter>] extends [never]
      ? [BindingCompatible<Spec, Adapter>] extends [never]
        ? `Body schema does not match the transport at ${Name}`
        : never
      : `Unsupported body kind "${UnsupportedKind<Spec, Adapter> & string}" at ${Name}`
    : never;

type BindingError<Contract, Adapter extends AnyTransport, Path extends string = ""> =
  Contract extends Endpoint
    ? EndpointBindingError<Contract, Adapter, Path extends "" ? Contract["template"] : Path>
    : Contract extends (...args: never[]) => unknown
      ? `Expected an endpoint or group at ${Path}`
      : Contract extends object
        ? {
            [Key in keyof Contract]-?: Key extends string | number
              ? BindingError<Contract[Key], Adapter, Path extends "" ? `${Key}` : `${Path}.${Key}`>
              : "Endpoint group keys must be strings or numbers";
          }[keyof Contract]
        : `Expected an endpoint or group at ${Path}`;

export type CheckBinding<Contract, Adapter extends AnyTransport> =
  [BindingError<Contract, Adapter>] extends [never] ? unknown : BindingError<Contract, Adapter>;

export type BoundContract<Contract, Adapter extends AnyTransport> =
  Contract extends Endpoint
    ? Operation<Contract, Adapter>
    : { readonly [Key in keyof Contract]: BoundContract<Contract[Key], Adapter> };
