import type { StandardSchemaV1 } from "./types.js";
import type {
  Endpoint,
  EndpointDefinition,
  NormalizedBody,
  NormalizedResponse,
  PathPlan,
  PreparedEndpoint,
  TypeHint,
  ValidateEndpoint,
} from "./contract-types.js";

function compilePath(url: string): PathPlan {
  const suffixStart = url.search(/[?#]/);
  // Only the part before `?` or `#` has parameters.
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

  if (names.length === 0) {
    return url;
  }

  parts.push(url.slice(literalStart));
  return { parts, names };
}

export function renderPath(plan: PathPlan, params: unknown): string {
  if (typeof plan === "string") {
    return plan;
  }

  const fields = params as Record<string, unknown> | undefined;
  let url = plan.parts[0]!;

  for (let i = 0; i < plan.names.length; i++) {
    const name = plan.names[i]!;
    const value = fields?.[name];

    if (value === undefined || value === null) {
      throw new TypeError(`Missing path parameter: ${name}`);
    }

    url += encodeURIComponent(String(value)) + plan.parts[i + 1]!;
  }

  return url;
}

const typeMarker = Object.freeze({});

export function type<Value>(): TypeHint<Value> {
  return typeMarker as TypeHint<Value>;
}

function executableSchema(input: unknown): StandardSchemaV1 | undefined {
  return input !== null && typeof input === "object" && "~standard" in input
    ? (input as StandardSchemaV1)
    : undefined;
}

function normalizeBody(input: unknown): NormalizedBody {
  if (typeof input === "string") {
    return { kind: input, schema: undefined };
  }

  if (input === undefined || input === typeMarker) {
    return { kind: "json", schema: undefined };
  }

  const schema = executableSchema(input);
  if (schema !== undefined) {
    return { kind: "json", schema };
  }

  const declaration = input as { kind: string; schema?: unknown };
  return { kind: declaration.kind, schema: executableSchema(declaration.schema) };
}

export function endpoint<const Url extends string>(url: Url): PreparedEndpoint<Url, {}>;

export function endpoint<const Url extends string, const Declaration extends EndpointDefinition>(
  url: Url,
  definition: Declaration & ValidateEndpoint<Url, Declaration>,
): PreparedEndpoint<Url, Declaration>;

export function endpoint(url: string, definition: EndpointDefinition = {}): Endpoint {
  const declaredResponses = definition.responses;
  const responses: Record<string, NormalizedResponse> = {};
  const kinds = new Set<string>();

  for (const status in declaredResponses) {
    const declared = declaredResponses[status as `${number}`]!;
    const descriptor =
      declared !== null &&
      typeof declared === "object" &&
      declared !== typeMarker &&
      !("~standard" in declared) &&
      "body" in declared
        ? declared
        : undefined;

    const body = normalizeBody(descriptor ? descriptor.body : declared);

    responses[status] = {
      kind: body.kind,
      bodySchema: body.schema,
      headersSchema: executableSchema(descriptor?.headers),
      responseKinds: [body.kind],
    };

    kinds.add(body.kind);
  }

  return {
    method: definition.method ?? "GET",
    path: compilePath(url),
    pathSchema: executableSchema(definition.path),
    querySchema: executableSchema(definition.query),
    headersSchema: executableSchema(definition.headers),
    body: normalizeBody(definition.body),
    responses,
    responseKinds: kinds.size === 0 ? ["none"] : [...kinds],
    meta: definition.meta ?? {},
  };
}
