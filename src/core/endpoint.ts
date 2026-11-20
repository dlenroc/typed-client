import type {
  BodyDeclaration,
  CheckedDefinition,
  Endpoint,
  EndpointDefinition,
  NormalizedBody,
  NormalizedResponse,
  PathNames,
  PreparedRequestBody,
  PreparedResponse,
  PreparedMeta,
  PreparedSchema,
  SchemaLike,
  TypeHint,
} from "./endpoint-types.js";
import { isRaw, rawParts } from "./raw.js";
import { urlScheme } from "../http.js";
import type { Reference, StandardSchemaV1 } from "./types.js";

export interface PathPlan {
  readonly parts: readonly string[];
  readonly names: readonly string[];
  readonly reference: Reference;
}

export function compilePath(url: string): PathPlan {
  // Only the part before `?` or `#` has parameters.
  const suffixStart = url.search(/[?#]/);
  const path = suffixStart < 0 ? url : url.slice(0, suffixStart);

  const names: string[] = [];
  const parts: string[] = [];
  let literalStart = 0;
  let open = path.indexOf("{");

  while (open >= 0) {
    const close = path.indexOf("}", open + 1);
    if (close < 0) {
      break;
    }

    // `{}` has no name, so it stays literal text.
    if (close > open + 1) {
      parts.push(url.slice(literalStart, open));
      names.push(url.slice(open + 1, close));
      literalStart = close + 1;
    }

    open = path.indexOf("{", close + 1);
  }

  parts.push(url.slice(literalStart));
  return { parts, names, reference: referenceOf(url) };
}

export function renderPath(plan: PathPlan, params: unknown): string {
  const fields = params as Record<string, unknown> | undefined;
  let url = plan.parts[0]!;

  for (let i = 0; i < plan.names.length; i++) {
    const name = plan.names[i]!;
    const given = fields?.[name];
    const raw = isRaw(given);
    const value = raw ? rawParts(given)[0] : given;

    if (value === undefined || value === null) {
      throw new TypeError(`Missing path parameter: ${name}`);
    }

    const text = raw ? String(value) : encodeURIComponent(String(value));
    url += text + plan.parts[i + 1]!;
  }

  return url;
}

/** Classify the written text of a template or of a raw path. */
export function referenceOf(text: string): Reference {
  if (text.startsWith("/")) {
    return text.startsWith("//") ? "network" : "path";
  }

  return urlScheme.test(text) ? "absolute" : "path";
}

const typeMarker = Object.freeze({});

export function type<Value>(): TypeHint<Value> {
  return typeMarker as TypeHint<Value>;
}

function executableSchema(input: unknown): StandardSchemaV1 | undefined {
  return (input as Partial<StandardSchemaV1> | undefined)?.["~standard"] === undefined
    ? undefined
    : (input as StandardSchemaV1);
}

// A body declaration is the normalized body itself, so an endpoint keeps it
// by reference.
function declareBody(kind: string, schema?: unknown): never {
  return Object.freeze({ kind, schema: executableSchema(schema) }) as never;
}

const noBody: NormalizedBody = declareBody("none");

/** Each built-in body kind, for completion. Transports can add kinds. */
type KnownKind = "json" | "text" | "binary" | "urlencoded" | "multipart" | "none" | "blob" | "stream";

export function json(): BodyDeclaration<"json", undefined>;
export function json<Value>(): BodyDeclaration<"json", TypeHint<Value>>;
export function json<const Schema extends SchemaLike>(schema: Schema): BodyDeclaration<"json", Schema>;
export function json(schema?: unknown): never {
  return declareBody("json", schema);
}

export function text(): BodyDeclaration<"text", undefined>;
export function text<Value extends string>(): BodyDeclaration<"text", TypeHint<Value>>;
export function text<const Schema extends SchemaLike>(schema: Schema): BodyDeclaration<"text", Schema>;
export function text(schema?: unknown): never {
  return declareBody("text", schema);
}

export function binary(): BodyDeclaration<"binary", undefined>;
export function binary<const Schema extends SchemaLike>(schema: Schema): BodyDeclaration<"binary", Schema>;
export function binary(schema?: unknown): never {
  return declareBody("binary", schema);
}

export function urlencoded(): BodyDeclaration<"urlencoded", undefined>;
export function urlencoded<Value>(): BodyDeclaration<"urlencoded", TypeHint<Value>>;
export function urlencoded<const Schema extends SchemaLike>(schema: Schema): BodyDeclaration<"urlencoded", Schema>;
export function urlencoded(schema?: unknown): never {
  return declareBody("urlencoded", schema);
}

export function multipart(): BodyDeclaration<"multipart", undefined>;
export function multipart<Value>(): BodyDeclaration<"multipart", TypeHint<Value>>;
export function multipart<const Schema extends SchemaLike>(schema: Schema): BodyDeclaration<"multipart", Schema>;
export function multipart(schema?: unknown): never {
  return declareBody("multipart", schema);
}

export function none(): BodyDeclaration<"none", undefined> {
  return noBody as never;
}

export function kind<const Kind extends KnownKind | (string & {})>(kind: Kind): BodyDeclaration<Kind, undefined>;
export function kind<const Kind extends KnownKind | (string & {}), const Schema extends SchemaLike>(
  kind: Kind,
  schema: Schema,
): BodyDeclaration<Kind, Schema>;
export function kind(kind: string, schema?: unknown): never {
  return declareBody(kind, schema);
}

function isBody(value: unknown): value is NormalizedBody {
  return typeof (value as Partial<NormalizedBody>).kind === "string";
}

export function endpoint<const Url extends string>(url: Url): Endpoint<
  Url,
  PathNames<Url>,
  {
    readonly path: undefined;
    readonly query: undefined;
    readonly headers: undefined;
    readonly body: { readonly kind: "none"; readonly schema: undefined };
  },
  {},
  {}
> & { readonly method: "GET" };

export function endpoint<const Url extends string, const Declaration extends EndpointDefinition>(
  url: Url,
  definition: CheckedDefinition<Url, Declaration>,
): Endpoint<
  Url,
  PathNames<Url>,
  {
    readonly path: PreparedSchema<Declaration, "path">;
    readonly query: PreparedSchema<Declaration, "query">;
    readonly headers: PreparedSchema<Declaration, "headers">;
    readonly body: PreparedRequestBody<Declaration>;
  },
  {
    readonly [Status in keyof Declaration["responses"]]: PreparedResponse<
      Declaration["responses"][Status]
    >;
  },
  PreparedMeta<Declaration>
> & {
  readonly method: "method" extends keyof Declaration
    ? | Exclude<Declaration["method"], undefined>
      | (undefined extends Declaration["method"] ? "GET" : never)
    : "GET";
};

export function endpoint(url: string, input: object = {}): Endpoint {
  const definition: EndpointDefinition = input;
  const declaredResponses = definition.responses;
  const responses: Record<string, NormalizedResponse> = {};

  for (const status in declaredResponses) {
    const declared: unknown = declaredResponses[status as `${number}`];
    if (isBody(declared)) {
      responses[status] = Object.freeze({ headers: undefined, body: declared });
    } else {
      const descriptor = declared as { readonly body?: unknown; readonly headers?: unknown };
      responses[status] = Object.freeze({
        headers: executableSchema(descriptor.headers),
        body: (descriptor.body as NormalizedBody | undefined) ?? noBody,
      });
    }
  }

  // The library freezes the objects that it creates. `meta` is the caller's
  // object.
  return Object.freeze({
    method: definition.method ?? "GET",
    template: url,
    params: Object.freeze(compilePath(url).names),
    request: Object.freeze({
      path: executableSchema(definition.path),
      query: executableSchema(definition.query),
      headers: executableSchema(definition.headers),
      body: (definition.body as NormalizedBody | undefined) ?? noBody,
    }),
    responses: Object.freeze(responses),
    meta: definition.meta ?? {},
  });
}
