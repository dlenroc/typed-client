import type {
  Endpoint,
  NormalizedRequest,
  NormalizedResponse,
} from "./endpoint-types.js";

type SchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

/**
 * Request schemas receive the call inputs. Response schemas receive raw
 * headers or a decoded body. Both can validate asynchronously.
 *
 * @see {@link https://standardschema.dev/ | Standard Schema}
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

export interface StandardIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

export type FieldScalar = string | number | boolean | bigint | null | undefined;

type PairInput<Value> = readonly (readonly [string, Value])[];

export type Fields<Value> =
  | Readonly<Record<string, Value | readonly Value[]>>
  | PairInput<Value>;

/**
 * The client sends a string without encoding it. Repeat pairs or use
 * arrays in records. Omit a field with `undefined` or send an empty value
 * with `null`.
 */
export type QueryInput = string | Fields<FieldScalar>;

/**
 * Request headers by name.
 *
 * @remarks
 * The client sends header names as given. Names that differ only in case
 * are one header, so the client sends the last spelling and the last
 * value. k6, Playwright, and HTTP/2 can change the case. `undefined` is
 * the same as leaving the header out, `null` suppresses the header and
 * its default, and `""` sends an empty value.
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

// k6 has no FormData global. Browser and Node consumers use their native type.
export type NativeFormData = typeof globalThis extends {
  FormData: { prototype: infer Form };
} ? Form : never;

/**
 * Repeat pairs or use arrays in records. Omit a field with `undefined` or
 * send an empty value with `null`.
 */
export type MultipartInput = Fields<FieldScalar | MultipartFile> | NativeFormData;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export type UrlEncodedResponse = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type MultipartResponseValue = string | MultipartFile<Uint8Array<ArrayBuffer>>;

export type MultipartResponse = Readonly<
  Record<
    string,
    MultipartResponseValue | readonly MultipartResponseValue[] | undefined
  >
>;

/**
 * Response headers with lowercase names. Repeated values are joined with
 * `", "`, and repeated `Set-Cookie` values with a newline.
 */
export type ResponseHeaders = {
  readonly [Name in string]: string | undefined;
};

/** Extend or pick from these request kinds when defining a transport. */
export interface RequestKindMap {
  readonly none: undefined;

  /**
   * Serialized with `JSON.stringify`. If serialization fails, the call
   * throws a `request` error.
   */
  readonly json: unknown;
  readonly text: string;
  readonly binary: BinaryInput;
  readonly urlencoded: QueryInput;

  /**
   * The encoder sets the boundary, so the client removes a `Content-Type`
   * of the caller. With a raw headers value, the client sends a supplied
   * `Content-Type` unchanged.
   */
  readonly multipart: MultipartInput;
}

/** Extend or pick from these response kinds when defining a transport. */
export interface ResponseKindMap {
  readonly none: undefined;
  readonly json: JsonValue;
  readonly text: string;
  readonly binary: Uint8Array<ArrayBuffer>;
  readonly urlencoded: UrlEncodedResponse;
  readonly multipart: MultipartResponse;
}

/**
 * How a template or a raw path starts. `absolute`: with a scheme.
 * `network`: with `//`. `path`: all others.
 */
export type Reference = "absolute" | "network" | "path";

/**
 * The request that the client prepares for a transport. Treat nested
 * inputs as read-only.
 */
export interface TransportRequest<
  Requests extends object = RequestKindMap,
  Responses extends object = ResponseKindMap,
  Options = unknown,
> {
  /** The endpoint of this call, by reference. */
  readonly endpoint: Endpoint<
    string,
    string,
    NormalizedRequest,
    {
      readonly [status: number]: NormalizedResponse & {
        readonly body: { readonly kind: keyof Responses & string };
      };
    }
  >;

  method: string;

  /** The rendered template and query, or the raw `path` string. */
  url: string;

  /**
   * How the written template, or the raw `path` string, starts. Parameter
   * values do not change it.
   */
  reference: Reference;

  /** Values are a scalar or `null`. There are no `undefined` values. */
  headers?: HeaderInput | undefined;

  bodyKind: keyof Requests & string;

  /** `undefined` omits the body. Send JSON `null` as a value. */
  body?: unknown;

  /** True if the client does not decode the body. */
  discard: boolean;

  /** Milliseconds to wait for the response, if the caller set a limit. */
  timeout: number | undefined;

  /** True if the transport must follow redirects. */
  follow: boolean;

  /** The `status` value of the call, if the caller set it. */
  status: number | readonly number[] | undefined;

  /** The `transport` value of the call, by reference. */
  readonly options: Options | undefined;
}

/**
 * The response that a transport returns. The client calls `read` at most
 * once. The caller owns live resources returned by a successful call.
 */
export type TransportResponse<
  Responses extends object = ResponseKindMap,
  Metadata extends object = never,
> = {
  readonly status: number;
  readonly url: string;
  readonly headers: ResponseHeaders;

  /**
   * Decode once and release resources that the result does not need.
   * Use `none` to discard the body. On an unexpected textual status the
   * client requests `text` even if no endpoint declares that kind. Return
   * `undefined` if the adapter has no diagnostic text to provide.
   * Attach any secondary cleanup failure to a decoding error as `cleanupError`.
   */
  read<Kind extends (keyof Responses & string) | "none" | "text">(
    kind: Kind,
  ): Promise<(Responses & {
    readonly none: undefined;
    readonly text: "text" extends keyof Responses ? Responses["text"] : string | undefined;
  })[Kind]>;

  /**
   * Release a live value that `read` returned, for example a stream. The
   * client calls it when a schema rejects that value.
   */
  discard?(): Promise<void>;
} & ([Metadata] extends [never]
  ? { readonly transport?: undefined }
  : {
      /**
       * Set on every response. Copy out metadata that would otherwise
       * retain the native response.
       */
      readonly transport: Metadata;
    });

/**
 * A function that sends a prepared request and returns a
 * {@link TransportResponse}.
 *
 * @remarks
 * See {@link TransportRequest} for the prepared input and
 * {@link TransportResponse} for response ownership.
 * Read the `transport` value of the call from `request.options` and expose
 * metadata through the response's `transport` field. Apply
 * `request.timeout` and `request.follow` if the transport can. Before
 * retrying a request, release the previous response with `read("none")`.
 * If creating the `TransportResponse` fails, release the native response.
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
 * const endpoint = c.endpoint("/ping", { responses: { 204: c.none() } });
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

export type AnyTransport = (
  request: TransportRequest<any, {}, any>,
) => Promise<TransportResponse<{}, never> | TransportResponse<{}, object>>;
