import type {
  FieldScalar,
  HeaderInput,
  JsonValue,
  MultipartFile,
  MultipartInput,
  NativeFormData,
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
      ? "types" extends keyof Schema["~standard"]
        ? NonNullable<Schema["~standard"]["types"]>["input"]
        : unknown
      : never;

export type SchemaOutput<Schema> =
  Schema extends TypeHint<infer Output>
    ? Output
    : Schema extends StandardSchemaV1<any, any>
      ? "types" extends keyof Schema["~standard"]
        ? NonNullable<Schema["~standard"]["types"]>["output"]
        : Extract<
            Awaited<ReturnType<Schema["~standard"]["validate"]>>,
            { readonly value: unknown }
          >["value"]
      : never;

export type PathScalar = string | number | boolean | bigint;

export type Defined<Value> = Exclude<Value, undefined>;

// Without `strictNullChecks`, `undefined` is assignable to every type.
type NullChecks = undefined extends string ? false : true;

/**
 * True if a type accepts `undefined`. Without `strictNullChecks`, no type
 * says so, and the result is false.
 */
export type AcceptsUndefined<Value> =
  NullChecks extends true ? (undefined extends Value ? true : false) : false;

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
              : IsFieldValue<Defined<Value[Key]>, Scalar | readonly Scalar[]>;
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
                ? [Defined<Value>] extends [NativeFormData]
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

// A check is `unknown` if it passes. Otherwise it is a message, which the
// editor shows as the expected type.
type RequestSchemaCheck<Schema, Wire, Message extends string> =
  Schema extends SchemaLike
    ? IsRequestValue<SchemaOutput<Schema>, Wire> extends true
      ? unknown
      : Message
    : never;

// A failed check replaces the declared value with its message.
type WithCheck<Value, Check> = Check extends string ? Check : Value & Check;

type FirstFailure<First, Second> = unknown extends First ? Second : First;

export type ResponseSchemaCheck<Schema, Wire> =
  SameType<Wire, JsonValue> extends true
    ? unknown
    : Schema extends TypeHint<infer Value>
      ? IsWireValue<Value, Wire> extends true
        ? unknown
        : [Wire] extends [Value]
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

declare const bodyMark: unique symbol;

/**
 * A body declaration: a kind and an optional schema. Create it with
 * `c.json()`, `c.text()`, `c.binary()`, `c.urlencoded()`, `c.multipart()`,
 * `c.none()`, or `c.kind()`.
 */
export interface BodyDeclaration<
  Kind extends string = string,
  Schema extends SchemaLike | undefined = SchemaLike | undefined,
> {
  readonly [bodyMark]: { readonly kind: Kind; readonly schema: Schema };
}

interface ResponseDescriptor {
  /** @defaultValue `c.none()` */
  readonly body?: BodyDeclaration;

  /** Receives raw, lowercase header names and can transform them. */
  readonly headers?: SchemaLike;
}

type ResponseDeclaration = BodyDeclaration | ResponseDescriptor;

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
   * The request body, for example `c.json<User>()`.
   *
   * @defaultValue `c.none()`: the call sends no body
   */
  readonly body?: BodyDeclaration;

  /**
   * The responses by status, for example `{ 200: c.json<User>() }`. Use
   * `{ body, headers }` to validate headers. If there are no declared
   * responses, pass `status` on each call.
   */
  readonly responses?: Readonly<Record<number, ResponseDeclaration>>;

  /** Passed by reference to the transport and included in `ClientError`. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface NormalizedBody {
  readonly kind: string;
  readonly schema: SchemaLike | undefined;
}

export interface NormalizedRequest {
  readonly path: SchemaLike | undefined;
  readonly query: SchemaLike | undefined;
  readonly headers: SchemaLike | undefined;
  readonly body: NormalizedBody;
}

export interface NormalizedResponse {
  readonly headers: SchemaLike | undefined;
  readonly body: NormalizedBody;
}

type PreparedBodyKind<Kind extends string, Schema> =
  Kind extends unknown ? { readonly kind: Kind; readonly schema: Schema } : never;

// A `c.type` hint has no runtime schema, so a schema can be `undefined`.
type PreparedBody<Body> =
  Body extends BodyDeclaration<infer Kind, infer Schema>
    ? PreparedBodyKind<Kind, Schema | undefined>
    : never;

type NoBody = { readonly kind: "none"; readonly schema: undefined };

export type PreparedSchema<Declaration, Field extends string> =
  Declaration extends { readonly [Key in Field]: infer Schema extends SchemaLike }
    ? Schema | undefined
    : undefined;

type PreparedResponseBody<Body extends NormalizedBody, Headers = undefined> =
  Body extends unknown ? { readonly headers: Headers; readonly body: Body } : never;

export type PreparedResponse<Declaration> =
  Declaration extends BodyDeclaration
    ? PreparedResponseBody<PreparedBody<Declaration>>
    : PreparedResponseBody<
        Declaration extends { readonly body: infer Body extends BodyDeclaration }
          ? PreparedBody<Body>
          : NoBody,
        PreparedSchema<Declaration, "headers">
      >;

/**
 * The normalized data of an endpoint. Each field is always present.
 */
export interface Endpoint<
  Template extends string = string,
  Param extends string = string,
  Request extends NormalizedRequest = NormalizedRequest,
  Responses extends Readonly<Record<number, NormalizedResponse>> = Readonly<
    Record<number, NormalizedResponse>
  >,
  Meta extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly method: string;

  /** The URL template as written, for example `/users/{id}`. */
  readonly template: Template;

  /** The names of the path parameters, in template order. */
  readonly params: readonly Param[];

  /** One schema for each call field, and the body kind. */
  readonly request: Request;

  /** The declared responses by status. */
  readonly responses: Responses;

  /** The `meta` value of the definition, by reference, or `{}`. */
  readonly meta: Meta;
}

export type PreparedMeta<Declaration> =
  Declaration extends { readonly meta: infer Meta extends Readonly<Record<string, unknown>> }
    ? Meta
    : {};

export type PreparedRequestBody<Declaration> =
  Declaration extends { readonly body: infer Body extends BodyDeclaration }
    ? PreparedBody<Body>
    : NoBody;

export type PathNames<Url extends string> =
  string extends Url ? string : TemplateNames<PathOnly<Url>>;

type RequestBodyCheck<Body> =
  Body extends BodyDeclaration<infer Kind, infer Schema>
    ? [Schema] extends [undefined]
      ? unknown
      : RequestSchemaCheck<
          Schema,
          KindInput<Kind>,
          `Body schema output does not match kind: ${Kind}`
        >
    : never;

type ResponseSchemaMessage<Schema, Wire, Message extends string> =
  [ResponseSchemaCheck<Schema, Wire>] extends [never] ? Message : unknown;

type ResponseBodyCheck<Body> =
  Body extends BodyDeclaration<infer Kind, infer Schema>
    ? [Schema] extends [undefined]
      ? unknown
      : ResponseSchemaMessage<
          Schema,
          KindOutput<Kind>,
          `Response schema input does not accept the decoded body of kind: ${Kind}`
        >
    : never;

type UppercaseKeys<Value> = {
  [Key in keyof Value]-?: Key extends string
    ? string extends Key
      ? never
      : Key extends Lowercase<Key>
        ? never
        : Key
    : never;
}[keyof Value];

// Response header names are lowercase, so a key with uppercase never matches.
type ResponseHeaderCheck<Headers> = FirstFailure<
  ResponseSchemaMessage<
    Headers,
    ResponseHeaders,
    "Response header schema input must accept string values"
  >,
  [UppercaseKeys<SchemaInput<Headers>>] extends [never]
    ? unknown
    : `Response header names are lowercase: ${UppercaseKeys<SchemaInput<Headers>> & string}`
>;

// An optional declaration changes the required call inputs or the decoded
// response. Require it to be narrowed before constructing the endpoint.
type OptionalKey<Declaration, Key extends keyof Declaration> =
  Pick<Declaration, Key> extends Required<Pick<Declaration, Key>> ? never : Key;

type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;

// A union of independently declared objects can omit a key without
// TypeScript marking it optional on either branch.
type RequireSameKeys<Value> = [KeysOfUnion<Value>] extends [keyof Value] ? unknown : never;

type RejectOptional<Declaration, Fields extends PropertyKey> = {
  readonly [Key in keyof Declaration as Key extends Fields
    ? OptionalKey<Declaration, Key>
    : never]?: never;
};

type ValidResponseDescriptor<Declaration> =
  (Declaration extends { readonly body: infer Body extends BodyDeclaration }
    ? { readonly body: WithCheck<Body, ResponseBodyCheck<Body>> }
    : unknown) &
  (Declaration extends { readonly headers: infer Headers extends SchemaLike }
    ? { readonly headers: WithCheck<Headers, ResponseHeaderCheck<Headers>> }
    : unknown);

type ValidResponse<Declaration> =
  Declaration extends BodyDeclaration
    ? WithCheck<Declaration, ResponseBodyCheck<Declaration>>
    : ResponseDescriptor &
      ValidResponseDescriptor<Declaration> &
      RejectOptional<Declaration, "headers" | "body">;

type MissingPathNames<Url extends string, Output> = Exclude<
  PathNames<Url>,
  { [Key in keyof Output]-?: Output[Key] extends PathScalar ? Key : never }[keyof Output]
>;

type RequiredPathOutput<Url extends string, Output> =
  string extends Url
    ? unknown
    : [PathNames<Url>] extends [never]
      ? unknown
      : IsAny<Output> extends true
        ? unknown
        : AcceptsUndefined<Output> extends true
          ? "Path schema output must not be undefined"
          : [MissingPathNames<Url, Output>] extends [never]
            ? unknown
            : `Path schema output needs parameter: ${MissingPathNames<Url, Output>}`;

type ValidPathField<Url extends string, Declaration extends EndpointDefinition> =
  Declaration extends { readonly path: infer Schema extends SchemaLike }
    ? {
        readonly path: WithCheck<
          Schema,
          FirstFailure<
            RequestSchemaCheck<
              Schema,
              Readonly<Record<string, PathScalar>>,
              "Path schema output must have string, number, boolean, or bigint values"
            >,
            RequiredPathOutput<Url, SchemaOutput<Schema>>
          >
        >;
      }
    : unknown;

type ValidQueryField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly query: infer Schema extends SchemaLike }
    ? {
        readonly query: WithCheck<
          Schema,
          RequestSchemaCheck<
            Schema,
            QueryInput,
            "Query schema output must be a string or fields of scalar values"
          >
        >;
      }
    : unknown;

type ValidHeaderField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly headers: infer Schema extends SchemaLike }
    ? {
        readonly headers: WithCheck<
          Schema,
          RequestSchemaCheck<
            Schema,
            HeaderInput,
            "Header schema output must be a record of scalar values"
          >
        >;
      }
    : unknown;

type ValidBodyField<Declaration extends EndpointDefinition> =
  Declaration extends { readonly body: infer Body extends BodyDeclaration }
    ? { readonly body: WithCheck<Body, RequestBodyCheck<Body>> }
    : unknown;

type StatusKeys = number | `${number}`;

type ValidResponses<Responses> =
  [Exclude<keyof Responses, StatusKeys>] extends [never]
    ? {
        readonly [Status in keyof Responses]: ValidResponse<Responses[Status]>;
      } & RejectOptional<Responses, StatusKeys> & RequireSameKeys<Responses>
    : `Response status must be a number: ${Exclude<keyof Responses, StatusKeys> & string}`;

// `Declaration` is only an inference site, so TypeScript reports unknown keys.
export type CheckedDefinition<
  Url extends string,
  Declaration extends EndpointDefinition,
> = [Declaration] extends [never]
  ? Declaration
  : Omit<EndpointDefinition, Exclude<keyof Declaration, "method" | "meta"> | "responses"> &
      ValidateEndpoint<Url, Declaration> &
      RequireSameKeys<Declaration> &
      RejectOptional<Declaration, "path" | "query" | "headers" | "body" | "responses">;

type ValidateEndpoint<
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
