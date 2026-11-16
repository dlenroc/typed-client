type SchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

/**
 * Request schemas run before sending. Response schemas receive decoded
 * bodies or raw headers. Both may validate asynchronously.
 *
 * @see {@link https://standardschema.dev/ | Standard Schema}
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type FieldScalar = string | number | boolean | bigint | null | undefined;

type PairInput<Value> = readonly (readonly [string, Value])[];

export type Fields<Value> = Readonly<Record<string, Value | readonly Value[]>> | PairInput<Value>;

/**
 * Strings are already encoded. Repeat pairs or use arrays in records.
 * Omit a field with `undefined` or send an empty value with `null`.
 */
export type QueryInput = string | Fields<FieldScalar>;

/**
 * Header names are case-insensitive. `undefined` allows a default,
 * `null` suppresses it, and `""` sends an empty value.
 */
export type HeaderInput = Readonly<Record<string, FieldScalar>>;

/** A view sends only its selected byte range. */
export type BinaryInput = ArrayBuffer | ArrayBufferView;

export interface MultipartFile<Data = BinaryInput> {
  readonly data: Data;

  /** @defaultValue "blob" when sending a file */
  readonly filename?: string;

  /** @defaultValue "application/octet-stream" when sending a file */
  readonly mediaType?: string;
}

/**
 * For repeated fields, use arrays in a record or repeat name-value pairs.
 * Omit fields with `undefined` or send empty values with `null`.
 */
export type MultipartInput = Fields<FieldScalar | MultipartFile> | FormData;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export type UrlEncodedResponse = Readonly<Record<string, string | readonly string[] | undefined>>;

export type MultipartResponseValue = string | MultipartFile<Uint8Array>;

export type MultipartResponse = Readonly<
  Record<string, MultipartResponseValue | readonly MultipartResponseValue[] | undefined>
>;

/** Lowercase names. Repeated values may be combined by the native API. */
export type ResponseHeaders = {
  readonly [Name in string]: string | readonly string[] | undefined;
};

/** Extend or pick from these request kinds when defining a transport. */
export interface RequestKindMap {
  readonly none: undefined;

  /** Serialized with `JSON.stringify`. Failures raise a `request` error. */
  readonly json: unknown;
  readonly text: string;
  readonly binary: BinaryInput;
  readonly urlencoded: QueryInput;

  /**
   * Checked calls use the encoder's Content-Type boundary. With
   * `unchecked: true`, a supplied Content-Type is sent as provided.
   */
  readonly multipart: MultipartInput;
}

/** Extend or pick from these response kinds when defining a transport. */
export interface ResponseKindMap {
  readonly none: undefined;
  readonly json: JsonValue;
  readonly text: string;
  readonly binary: Uint8Array;
  readonly urlencoded: UrlEncodedResponse;
  readonly multipart: MultipartResponse;
}

export interface CoreOptions<Status extends number = number> {
  /**
   * A status array must be nonempty. Accepted undeclared statuses return
   * an `undefined` body and raw headers.
   *
   * @defaultValue All declared response statuses
   */
  readonly status?: Status | readonly Status[];

  /**
   * Skip request schemas. Override `method`, `path`, or `bodyKind`.
   * Declared responses still use their schemas.
   *
   * @defaultValue false
   */
  readonly unchecked?: boolean;

  /**
   * Check status and headers, then discard the body before decoding.
   *
   * @defaultValue false
   */
  readonly discard?: boolean;
}

export interface RequestFields {
  readonly path?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

/**
 * Use the prepared fields to send the request. Treat nested inputs as
 * read-only.
 */
export interface TransportRequest<
  Requests extends object = RequestKindMap,
  Responses extends object = ResponseKindMap,
  Options = unknown,
> {
  method: string;

  /** URL before the transport applies its base URL. */
  url: string;

  headers?: HeaderInput | undefined;

  bodyKind: keyof Requests & string;

  /** `undefined` omits the body. JSON `null` is sent as a value. */
  body?: Requests[keyof Requests] | undefined;

  /** Use these possible decoded kinds to choose the native capture mode. */
  responseKinds: readonly (keyof Responses & string)[];

  /** The endpoint's metadata object, passed by reference. */
  readonly meta: Readonly<Record<string, unknown>>;

  /**
   * The original call object by reference. Includes raw request fields,
   * call controls, and transport options.
   */
  readonly input?:
    | (CoreOptions &
        RequestFields &
        Readonly<Options> & {
          readonly method?: string;
          readonly bodyKind?: keyof Requests & string;
        })
    | undefined;
}

/**
 * The client calls `read` at most once. The caller owns live resources
 * returned by a successful endpoint call.
 */
export interface TransportResponse<
  Responses extends object = ResponseKindMap,
  Metadata extends object = never,
> {
  readonly status: number;
  readonly url: string;
  readonly headers: ResponseHeaders;

  /** Copy out metadata that would otherwise retain the native response. */
  readonly transport?: Metadata | undefined;

  /**
   * Decode once and release resources that the result does not need.
   * Use `none` to discard the body. Attach any secondary cleanup failure
   * to a decoding error as `cleanupError`.
   */
  read<Kind extends (keyof Responses & string) | "none">(
    kind: Kind,
  ): Promise<(Responses & { readonly none: undefined })[Kind]>;

  /**
   * Release resources when status or schema checks reject the response.
   * May run before or after `read`. Without this method, the client uses
   * `read("none")` for unread responses.
   */
  discard?(): Promise<void>;
}

/**
 * See {@link TransportRequest} for the prepared input and
 * {@link TransportResponse} for response ownership.
 *
 * @remarks
 * Read transport options from `request.input` and expose metadata through
 * the handle's `transport` field. Before retrying a request, release the
 * previous response with `discard()` or `read("none")`. Release the
 * native response if handle creation fails.
 *
 * @example
 * ```ts
 * import { c } from "@dlenroc/typed-client";
 * import type { RequestKindMap, Transport } from "@dlenroc/typed-client";
 *
 * const empty: Transport<RequestKindMap, { none: undefined }> =
 *   async ({ url }) => ({
 *     url,
 *     status: 204,
 *     headers: {},
 *     read: async () => undefined,
 *   });
 * const endpoint = c.endpoint("/ping", { responses: { 204: "none" } });
 * const ping = c.bind(endpoint, empty);
 * await ping();
 * ```
 */
export type Transport<
  Requests extends object = RequestKindMap,
  Responses extends object = ResponseKindMap,
  Options = object,
  Metadata extends object = never,
> = (
  request: TransportRequest<Requests, Responses, Options>,
) => Promise<TransportResponse<Responses, Metadata>>;

export type AnyTransport = Transport<any, {}, any, any>;
