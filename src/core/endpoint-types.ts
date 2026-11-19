import type {
  FieldScalar,
  HeaderInput,
  JsonValue,
  MultipartFile,
  MultipartInput,
  QueryInput,
  RequestKindMap,
  ResponseHeaders,
  ResponseKindMap,
  StandardSchemaV1,
} from "./types.js";

declare const hintType: unique symbol;

/** The type that `c.type<T>()` returns. */
export type TypeHint<Value> = { readonly [hintType]: (value: Value) => Value };

export type SchemaLike = TypeHint<any> | StandardSchemaV1<any, any>;

export type SchemaInput<Schema> =
  Schema extends TypeHint<infer Input>
    ? Input
    : Schema extends StandardSchemaV1<any, any>
      ? NonNullable<Schema["~standard"]["types"]>["input"]
      : never;

export type SchemaOutput<Schema> =
  Schema extends TypeHint<infer Output>
    ? Output
    : Schema extends StandardSchemaV1<any, any>
      ? NonNullable<Schema["~standard"]["types"]>["output"]
      : never;

export type PathScalar = string | number | boolean | bigint;

export type Defined<Value> = Exclude<Value, undefined>;
export type IsAny<Value> = 0 extends 1 & Value ? true : false;

type AllTrue<Results> = Exclude<Results, true> extends never ? true : false;

type PairValueValid<Entry, Scalar> =
  Entry extends readonly [string, infer Value]
    ? IsFieldValue<Value, Scalar>
    : false;

type IsFieldCollection<Value, Scalar> =
  Value extends readonly (infer Entry)[]
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

type IsHeaderRecord<Value> =
  Value extends readonly unknown[]
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

type SameType<Left, Right> =
  [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

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

type PossibleBranch<Value, Wire> =
  Value extends unknown ? IsWireValue<Value, Wire> : never;

type AcceptsDecodedValue<Value, Wire> =
  unknown extends Value
    ? true
    : true extends PossibleBranch<Value, Wire>
      ? true
      : [Wire] extends [Value]
        ? true
        : false;

export type KindInput<Kind extends string> =
  Kind extends keyof RequestKindMap ? RequestKindMap[Kind] : unknown;

type KindOutput<Kind extends string> =
  Kind extends keyof ResponseKindMap ? ResponseKindMap[Kind] : unknown;

export type IsRequestValue<Value, Wire> =
  [Defined<Value>] extends [never] ? true : IsWireValue<Value, Wire>;

type RequestSchemaCheck<Schema, Wire> =
  Schema extends SchemaLike
    ? IsRequestValue<SchemaOutput<Schema>, Wire> extends true
      ? unknown
      : never
    : never;

export type ResponseSchemaCheck<Schema, Wire> =
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
export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | (string & {});

type RequestKindName = keyof RequestKindMap | (string & {});

type ResponseKindName =
  | keyof ResponseKindMap
  | "blob"
  | "stream"
  | (string & {});

interface BodyDescriptor<Kind extends string = string> {
  readonly kind: Kind;

  /**
   * Request schemas produce the wire value. Response schemas receive
   * the decoded body.
   */
  readonly schema?: SchemaLike;
  readonly "~standard"?: never;
}

type BodySpec<Kind extends string = string> =
  | Kind
  | SchemaLike
  | BodyDescriptor<Kind>;

interface ResponseDescriptor {
  readonly body: BodySpec<ResponseKindName>;

  /** Receives raw, lowercase header names and can transform them. */
  readonly headers?: SchemaLike;
  readonly "~standard"?: never;
  readonly [hintType]?: never;
}

type ResponseDefinition =
  | ResponseKindName
  | SchemaLike
  | (BodyDescriptor<ResponseKindName> & {
      readonly body?: never;
      readonly headers?: never;
    })
  | ResponseDescriptor;

export interface EndpointDefinition {
  /** @defaultValue "GET" */
  readonly method?: HttpMethod;

  /**
   * Schema for the `path` call field. Its output fills `{name}`
   * parameters.
   */
  readonly path?: SchemaLike;

  /** Schema for the `query` call field. Runs before URL encoding. */
  readonly query?: SchemaLike;

  /**
   * Schema for the `headers` call field. Runs before the transport applies
   * header defaults.
   */
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
   * Body schemas receive the decoded value. If there are no declared
   * responses, pass `status` on each call.
   */
  readonly responses?: Readonly<Record<number, ResponseDefinition>>;

  /** Passed by reference to the transport and included in `ClientError`. */
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

type PreparedBodyKind<Kind extends string, Schema> =
  Kind extends unknown ? { readonly kind: Kind; readonly schema: Schema } : never;

type PreparedBody<Body extends BodySpec> =
  Body extends SchemaLike
    ? { readonly kind: "json"; readonly schema: Body | undefined }
    : Body extends string
      ? { readonly kind: Body; readonly schema: undefined }
      : Body extends BodyDescriptor
        ? PreparedBodyKind<Body["kind"], PreparedSchema<Body, "schema">>
        : never;

type PreparedSchema<Declaration, Field extends string> =
  Declaration extends { readonly [Key in Field]: infer Schema extends SchemaLike }
    ? Schema | undefined
    : undefined;

type PreparedResponseBody<Body extends NormalizedBody, Headers = undefined> =
  Body extends unknown
    ? {
        readonly kind: Body["kind"];
        readonly bodySchema: Body["schema"];
        readonly headersSchema: Headers;
        readonly responseKinds: readonly string[];
      }
    : never;

type PreparedResponse<Declaration> =
  Declaration extends ResponseDescriptor
    ? PreparedResponseBody<
        PreparedBody<Declaration["body"]>,
        PreparedSchema<Declaration, "headers">
      >
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

type PreparedPath<Url extends string> =
  string extends Url
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

export type PreparedEndpoint<Url extends string, Declaration extends EndpointDefinition> =
  Endpoint<
    PreparedPath<Url>,
    PreparedSchema<Declaration, "path">,
    PreparedSchema<Declaration, "query">,
    PreparedSchema<Declaration, "headers">,
    Declaration extends { readonly body: infer Body extends BodySpec }
      ? PreparedBody<Body>
      : { readonly kind: "json"; readonly schema: undefined },
    PreparedResponses<NonNullable<Declaration["responses"]>>
  >;

type PathNames<Url extends string> =
  string extends Url ? string : TemplateNames<PathOnly<Url>>;

type RequestBodyCheck<Body> =
  Body extends string | SchemaLike
    ? unknown
    : Body extends BodyDescriptor
      ? Body extends { readonly schema: infer Schema }
        ? { readonly schema: RequestSchemaCheck<Schema, KindInput<Body["kind"]>> }
        : unknown
      : never;

type ResponseBodyCheck<Body> =
  Body extends string | SchemaLike
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

type ValidResponse<Declaration> =
  Declaration extends ResponseDescriptor
    ? ValidResponseDescriptor<Declaration>
    : ResponseBodyCheck<Declaration>;

type RequiredPathOutput<Url extends string, Output> =
  string extends Url
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

type ValidPathField<Url extends string, Declaration extends EndpointDefinition> =
  Declaration extends { readonly path: infer Schema extends SchemaLike }
    ? {
        readonly path: Schema &
          RequestSchemaCheck<Schema, Readonly<Record<string, PathScalar>>> &
          RequiredPathOutput<Url, SchemaOutput<Schema>>;
      }
    : unknown;

type ValidQueryField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly query: infer Schema extends SchemaLike }
    ? { readonly query: Schema & RequestSchemaCheck<Schema, QueryInput> }
    : unknown;

type ValidHeaderField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly headers: infer Schema extends SchemaLike }
    ? { readonly headers: Schema & RequestSchemaCheck<Schema, HeaderInput> }
    : unknown;

type ValidBodyField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly body: infer Body extends BodySpec }
    ? { readonly body: Body & RequestBodyCheck<Body> }
    : unknown;

type ValidResponses<Responses> = {
  readonly [Status in keyof Responses]: Responses[Status] &
    ValidResponse<Responses[Status]>;
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

type StripAfter<Text extends string, Delimiter extends string> =
  Text extends `${infer Prefix}${Delimiter}${string}` ? Prefix : Text;

type PathOnly<Url extends string> = StripAfter<StripAfter<Url, "?">, "#">;

// Match the runtime: each `{name}` is a parameter, and `{}` is literal text.
// The accumulator keeps the recursion in tail position for long templates.
type TemplateNames<Path extends string, Names extends string = never> =
  Path extends `${string}{${infer Name}}${infer Rest}`
    ? TemplateNames<Rest, Names | Exclude<Name, "">>
    : Names;
