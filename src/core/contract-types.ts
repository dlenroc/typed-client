import type {
  AnyTransport,
  CoreOptions,
  RequestFields,
  StandardSchemaV1,
  TransportRequest,
  TransportResponse,
  RequestKindMap,
  ResponseKindMap,
  QueryInput,
  HeaderInput,
  MultipartInput,
  FieldScalar,
  MultipartFile,
  JsonValue,
  ResponseHeaders,
} from "./types.js";

declare const hintType: unique symbol;

export type TypeHint<Value> = { readonly [hintType]: (value: Value) => Value };

type SchemaLike = TypeHint<any> | StandardSchemaV1<any, any>;

type SchemaInput<Schema> =
  Schema extends TypeHint<infer Input>
    ? Input
    : Schema extends StandardSchemaV1<any, any>
      ? NonNullable<Schema["~standard"]["types"]>["input"]
      : never;

type SchemaOutput<Schema> =
  Schema extends TypeHint<infer Output>
    ? Output
    : Schema extends StandardSchemaV1<any, any>
      ? NonNullable<Schema["~standard"]["types"]>["output"]
      : never;

type PathScalar = string | number | boolean | bigint;

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

type Defined<Value> = Exclude<Value, undefined>;
type IsAny<Value> = 0 extends 1 & Value ? true : false;

type AllTrue<Results> = Exclude<Results, true> extends never ? true : false;

type PairValueValid<Entry, Scalar> = Entry extends readonly [string, infer Value]
  ? IsFieldValue<Value, Scalar>
  : false;

type IsFieldCollection<Value, Scalar> = Value extends readonly (infer Entry)[]
  ? PairValueValid<Entry, Scalar>
  : Value extends object
    ? AllTrue<
        {
          [Key in keyof Value]-?: IsAny<Value[Key]> extends true
            ? true
            : Defined<Value[Key]> extends readonly (infer Item)[]
              ? IsFieldValue<Item, Scalar>
              : IsFieldValue<Defined<Value[Key]>, Scalar>;
        }[keyof Value]
      >
    : false;

type IsHeaderRecord<Value> = Value extends readonly unknown[]
  ? false
  : Value extends object
    ? AllTrue<
        {
          [Key in keyof Value]-?: IsAny<Value[Key]> extends true
            ? true
            : IsFieldValue<Value[Key], FieldScalar>;
        }[keyof Value]
      >
    : false;

type IsFieldValue<Value, Wire> = [Value] extends [Wire] ? true : false;

type SameType<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type IsWireValue<Value, Wire> =
  unknown extends Wire
    ? true
    : IsAny<Value> extends true
      ? true
      : [Defined<Value>] extends [never]
        ? [Wire] extends [undefined]
          ? true
          : false
        : SameType<Wire, Readonly<Record<string, PathScalar>>> extends true
          ? IsFieldCollection<Defined<Value>, PathScalar>
          : SameType<Wire, QueryInput> extends true
            ? Defined<Value> extends string
              ? true
              : IsFieldCollection<Defined<Value>, FieldScalar>
            : SameType<Wire, HeaderInput> extends true
              ? IsHeaderRecord<Defined<Value>>
              : SameType<Wire, MultipartInput> extends true
                ? [Defined<Value>] extends [FormData]
                  ? true
                  : IsFieldCollection<Defined<Value>, FieldScalar | MultipartFile>
                : [Defined<Value>] extends [Wire]
                  ? true
                  : false;

type PossibleBranch<Value, Wire> = Value extends unknown ? IsWireValue<Value, Wire> : never;

type AcceptsDecodedValue<Value, Wire> = unknown extends Value
  ? true
  : true extends PossibleBranch<Value, Wire>
    ? true
    : [Wire] extends [Value]
      ? true
      : false;

type KindInput<Kind extends string> = Kind extends keyof RequestKindMap
  ? RequestKindMap[Kind]
  : unknown;

type KindOutput<Kind extends string> = Kind extends keyof ResponseKindMap
  ? ResponseKindMap[Kind]
  : unknown;

type IsRequestValue<Value, Wire> = [Defined<Value>] extends [never]
  ? true
  : IsWireValue<Value, Wire>;

type RequestSchemaCheck<Schema, Wire> = Schema extends SchemaLike
  ? IsRequestValue<SchemaOutput<Schema>, Wire> extends true
    ? unknown
    : never
  : never;

type ResponseSchemaCheck<Schema, Wire> =
  SameType<Wire, JsonValue> extends true
    ? unknown
    : Schema extends TypeHint<infer Value>
      ? IsWireValue<Value, Wire> extends true
        ? unknown
        : never
      : Schema extends StandardSchemaV1<any, any>
        ? AcceptsDecodedValue<SchemaInput<Schema>, Wire> extends true
          ? unknown
          : never
        : never;

// Keep known literals visible in autocomplete while accepting custom values.
type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | (string & {});
type RequestKindName = keyof RequestKindMap | (string & {});
type ResponseKindName = keyof ResponseKindMap | "blob" | "stream" | (string & {});

interface BodyDescriptor<Kind extends string = string> {
  readonly kind: Kind;

  /**
   * Request schemas produce the wire value. Response schemas receive
   * the decoded body.
   */
  readonly schema?: SchemaLike;
  readonly "~standard"?: never;
}

type BodySpec<Kind extends string = string> = Kind | SchemaLike | BodyDescriptor<Kind>;

interface ResponseDescriptor {
  readonly body: BodySpec<ResponseKindName>;

  /** Receives raw, lowercase header names and may transform them. */
  readonly headers?: SchemaLike;
  readonly "~standard"?: never;
  readonly [hintType]?: never;
}

type ResponseDefinition =
  | ResponseKindName
  | SchemaLike
  | (BodyDescriptor<ResponseKindName> & { readonly body?: never; readonly headers?: never })
  | ResponseDescriptor;

export interface EndpointDefinition {
  /** @defaultValue "GET" */
  readonly method?: HttpMethod;

  /** Transform call input into the values for `:name` segments. */
  readonly path?: SchemaLike;

  /** Runs before URL encoding. */
  readonly query?: SchemaLike;

  /** Runs before the transport applies header defaults. */
  readonly headers?: SchemaLike;

  /**
   * A direct type hint or schema selects JSON.
   * Use `"none"` to forbid a body or `{ kind, schema }` to validate
   * another body kind.
   *
   * @defaultValue Optional JSON
   */
  readonly body?: BodySpec<RequestKindName>;

  /**
   * Use `{ body, headers }` to validate headers alongside the body.
   * Body schemas receive the decoded value.
   * Calls require `status` when this map is empty or omitted.
   */
  readonly responses?: Readonly<Record<number, ResponseDefinition>>;

  /** Passed by reference to the transport and included in ClientError. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface NormalizedBody {
  readonly kind: string;
  readonly schema: SchemaLike | undefined;
}

export interface NormalizedResponse {
  readonly kind: string;
  readonly bodySchema: SchemaLike | undefined;
  readonly headersSchema: SchemaLike | undefined;
  readonly responseKinds: readonly string[];
}

type PreparedBodyKind<Kind extends string, Schema> = Kind extends unknown
  ? { readonly kind: Kind; readonly schema: Schema }
  : never;

type PreparedBody<Body extends BodySpec> = Body extends SchemaLike
  ? { readonly kind: "json"; readonly schema: Body | undefined }
  : Body extends string
    ? { readonly kind: Body; readonly schema: undefined }
    : Body extends BodyDescriptor
      ? PreparedBodyKind<Body["kind"], PreparedSchema<Body, "schema">>
      : never;

type PreparedSchema<Declaration, Field extends string> = Declaration extends {
  readonly [Key in Field]: infer Schema extends SchemaLike;
}
  ? Schema | undefined
  : undefined;

type PreparedResponseBody<Body extends NormalizedBody, Headers = undefined> = Body extends unknown
  ? {
      readonly kind: Body["kind"];
      readonly bodySchema: Body["schema"];
      readonly headersSchema: Headers;
      readonly responseKinds: readonly string[];
    }
  : never;

type PreparedResponse<Declaration> = Declaration extends ResponseDescriptor
  ? PreparedResponseBody<PreparedBody<Declaration["body"]>, PreparedSchema<Declaration, "headers">>
  : Declaration extends BodySpec
    ? PreparedResponseBody<PreparedBody<Declaration>>
    : never;

type PreparedResponses<Responses> = {
  readonly [Status in keyof Responses]: PreparedResponse<Responses[Status]>;
};

export type PathPlan =
  | string
  | {
      readonly parts: readonly string[];
      readonly names: readonly string[];
    };

type PreparedPath<Url extends string> = string extends Url
  ? PathPlan
  : [PathNames<Url>] extends [never]
    ? Url
    : {
        readonly parts: readonly string[];
        readonly names: readonly PathNames<Url>[];
      };

export interface Endpoint<
  Path extends PathPlan = PathPlan,
  PathSchema extends SchemaLike | undefined = SchemaLike | undefined,
  QuerySchema extends SchemaLike | undefined = SchemaLike | undefined,
  HeadersSchema extends SchemaLike | undefined = SchemaLike | undefined,
  Body extends NormalizedBody = NormalizedBody,
  Responses extends Readonly<Record<number, NormalizedResponse>> = Readonly<
    Record<number, NormalizedResponse>
  >,
> {
  readonly method: string;
  readonly path: Path;
  readonly pathSchema: PathSchema;
  readonly querySchema: QuerySchema;
  readonly headersSchema: HeadersSchema;
  readonly body: Body;
  readonly responses: Responses;
  readonly responseKinds: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export type PreparedEndpoint<Url extends string, Declaration extends EndpointDefinition> = Endpoint<
  PreparedPath<Url>,
  PreparedSchema<Declaration, "path">,
  PreparedSchema<Declaration, "query">,
  PreparedSchema<Declaration, "headers">,
  Declaration extends { readonly body: infer Body extends BodySpec }
    ? PreparedBody<Body>
    : { readonly kind: "json"; readonly schema: undefined },
  PreparedResponses<NonNullable<Declaration["responses"]>>
>;

type RequestBodyCheck<Body> = Body extends string | SchemaLike
  ? unknown
  : Body extends BodyDescriptor
    ? Body extends { readonly schema: infer Schema }
      ? { readonly schema: RequestSchemaCheck<Schema, KindInput<Body["kind"]>> }
      : unknown
    : never;

type ResponseBodyCheck<Body> = Body extends string | SchemaLike
  ? unknown
  : Body extends BodyDescriptor
    ? Body extends { readonly schema: infer Schema }
      ? { readonly schema: ResponseSchemaCheck<Schema, KindOutput<Body["kind"]>> }
      : unknown
    : never;

type ValidResponseDescriptor<Declaration extends ResponseDescriptor> = {
  readonly body: Declaration["body"] & ResponseBodyCheck<Declaration["body"]>;
} & (Declaration extends { readonly headers: infer Headers extends SchemaLike }
  ? { readonly headers: Headers & ResponseSchemaCheck<Headers, ResponseHeaders> }
  : unknown);

type ValidResponse<Declaration> = Declaration extends ResponseDescriptor
  ? ValidResponseDescriptor<Declaration>
  : ResponseBodyCheck<Declaration>;

type RequiredPathOutput<Url extends string, Output> = string extends Url
  ? unknown
  : [PathNames<Url>] extends [never]
    ? unknown
    : IsAny<Output> extends true
      ? unknown
      : undefined extends Output
        ? never
        : [Output] extends [Readonly<Record<PathNames<Url>, PathScalar>>]
          ? unknown
          : never;

type ValidPathField<
  Url extends string,
  Declaration extends EndpointDefinition,
> = Declaration extends {
  readonly path: infer Schema extends SchemaLike;
}
  ? {
      readonly path: Schema &
        RequestSchemaCheck<Schema, Readonly<Record<string, PathScalar>>> &
        RequiredPathOutput<Url, SchemaOutput<Schema>>;
    }
  : unknown;

type ValidQueryField<Declaration extends EndpointDefinition> = Declaration extends {
  readonly query: infer Schema extends SchemaLike;
}
  ? { readonly query: Schema & RequestSchemaCheck<Schema, QueryInput> }
  : unknown;

type ValidHeaderField<Declaration extends EndpointDefinition> = Declaration extends {
  readonly headers: infer Schema extends SchemaLike;
}
  ? { readonly headers: Schema & RequestSchemaCheck<Schema, HeaderInput> }
  : unknown;

type ValidBodyField<Declaration extends EndpointDefinition> = Declaration extends {
  readonly body: infer Body extends BodySpec;
}
  ? { readonly body: Body & RequestBodyCheck<Body> }
  : unknown;

type ValidResponses<Responses> = {
  readonly [Status in keyof Responses]: Responses[Status] & ValidResponse<Responses[Status]>;
};

export type ValidateEndpoint<
  Url extends string,
  Declaration extends EndpointDefinition,
> = ValidPathField<Url, Declaration> &
  ValidQueryField<Declaration> &
  ValidHeaderField<Declaration> &
  ValidBodyField<Declaration> & {
    readonly responses?: ValidResponses<NonNullable<Declaration["responses"]>>;
  };

type StripAfter<
  Text extends string,
  Delimiter extends string,
> = Text extends `${infer Prefix}${Delimiter}${string}` ? Prefix : Text;

type PathOnly<Url extends string> = StripAfter<StripAfter<Url, "?">, "#">;
type NameInSegment<Segment extends string> = Segment extends `:${infer Name}`
  ? Exclude<Name, "">
  : never;

type SegmentNames<Path extends string> = Path extends `${infer Head}/${infer Tail}`
  ? NameInSegment<Head> | SegmentNames<Tail>
  : NameInSegment<Path>;

type PathNames<Url extends string> = string extends Url ? string : SegmentNames<PathOnly<Url>>;

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
  : { readonly transport?: TransportMetadata<Adapter> };

type ResponseCase<Status extends number, Response, Adapter extends AnyTransport, Options> =
  Simplify<{
    readonly status: Status;
    readonly url: string;
    readonly headers: FinalHeaders<Response>;
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
 * Reuse checked call inputs with the bound transport's options.
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
 * Result with the body retained. Pass a status or union of statuses.
 * Defaults to all declared statuses. Status-only endpoints need a status.
 * Undeclared statuses yield raw headers and an undefined body.
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
         * Accepts any declared response status.
         *
         * @throws
         * A {@link ClientError} if the call fails.
         */
        (input?: undefined): Promise<ResultFor<Spec, Adapter, {}>>;
      }
    : {}
) & OperationTypes<Spec, Adapter> & {
  // Infer the flag before checking required fields so completions use it.
  /**
   * Accepts declared statuses by default. Pass `status` to select
   * which statuses to accept and narrow the result.
   *
   * @remarks
   * Use `unchecked: true` to skip request schemas and override the method,
   * path, or body kind. Use `discard: true` to check status and headers
   * without decoding or validating the response body.
   *
   * @throws
   * A {@link ClientError} for a failed call, including an unexpected status.
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
   * Accepts declared statuses by default. Pass `status` to select
   * which statuses to accept and narrow the result.
   *
   * @throws
   * A {@link ClientError} if the call fails.
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
