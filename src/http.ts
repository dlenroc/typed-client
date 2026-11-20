import type {
  BinaryInput,
  Fields,
  FieldScalar,
  HeaderInput,
  MultipartFile,
  MultipartInput,
  MultipartResponse,
  MultipartResponseValue,
  QueryInput,
  Reference,
  UrlEncodedResponse,
} from "./core/types.js";

// Shared by the built-in transports: URLs, headers, request encoding, and
// response decoding.

/** The scheme at the start of an absolute URL, with its colon. */
export const urlScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function appendQuery(url: string, query: QueryInput | undefined) {
  if (query === undefined) {
    return url;
  }

  const queryString = encodeFields(query);
  if (queryString === "") {
    return url;
  }

  const fragmentIndex = url.indexOf("#");
  const prefix = fragmentIndex < 0 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : url.slice(fragmentIndex);
  const separator = !prefix.includes("?")
    ? "?"
    : prefix.endsWith("?") || prefix.endsWith("&")
      ? ""
      : "&";

  return prefix + separator + queryString + fragment;
}

/**
 * Join a base URL and the URL of a request.
 *
 * @remarks
 * `path`: the base URL is a prefix. `network`: the scheme of the base
 * URL is a prefix. `absolute`: the URL is sent as written.
 */
export function createUrlResolver(
  baseUrl: string | undefined,
): (request: { readonly url: string; readonly reference: Reference }) => string {
  const base = baseUrl ?? "";
  const scheme = urlScheme.exec(base)?.[0] ?? "";

  return (request) =>
    request.reference === "path"
      ? base + request.url
      : request.reference === "network"
        ? scheme + request.url
        : request.url;
}

function defaultContentType(bodyKind: string) {
  switch (bodyKind) {
    case "json":
      return "application/json";
    case "text":
      return "text/plain; charset=UTF-8";
    case "urlencoded":
      return "application/x-www-form-urlencoded";
  }
}

export interface PreparedHeaders {
  readonly fields: Record<string, string>;

  /** The `Content-Type` value in `fields`, if `fields` has it. */
  readonly contentType: string | undefined;

  /** The caller set `Content-Type` to `null`. */
  readonly contentTypeSuppressed: boolean;
}

/** Merge names that differ only in case and add the default `Content-Type`. */
export function prepareHeaders(
  headers: HeaderInput | undefined,
  bodyKind: string,
  bodyPresent: boolean,
): PreparedHeaders {
  const fields: Record<string, string> = Object.create(null);

  // Map each lowercase name to the spelling that `fields` uses.
  const spellings: Record<string, string> = Object.create(null);
  let contentTypeSuppressed = false;

  if (headers !== undefined) {
    for (const name in headers) {
      const value = headers[name];
      if (value === undefined) {
        continue;
      }

      const key = name.toLowerCase();
      const previous = spellings[key];
      if (previous !== undefined) {
        delete fields[previous];
      }

      if (value === null) {
        delete spellings[key];
      } else {
        fields[name] = String(value);
        spellings[key] = name;
      }

      if (key === "content-type") {
        contentTypeSuppressed = value === null;
      }
    }
  }

  const contentTypeName = spellings["content-type"];
  let contentType = contentTypeName === undefined ? undefined : fields[contentTypeName];

  if (bodyPresent && contentType === undefined && !contentTypeSuppressed) {
    contentType = defaultContentType(bodyKind);
    if (contentType !== undefined) {
      fields["content-type"] = contentType;
    }
  }

  return { fields, contentType, contentTypeSuppressed };
}

/** Add a value under `key`. A repeated key collects its values in an array. */
export function appendValue<Value>(
  target: Record<string, Value | Value[]>,
  key: string,
  value: Value,
): void {
  const previous = target[key];

  if (previous === undefined) {
    target[key] = value;
  } else if (Array.isArray(previous)) {
    previous.push(value);
  } else {
    target[key] = [previous, value];
  }
}

/**
 * Add a response header under its lowercase name. A repeated header joins
 * its values with `", "`, which HTTP treats as the same. `Set-Cookie`
 * values can contain commas, so they are joined with a newline.
 */
export function appendResponseHeader(
  target: Record<string, string>,
  name: string,
  value: string,
): void {
  const key = name.toLowerCase();
  const previous = target[key];

  target[key] =
    previous === undefined
      ? value
      : previous + (key === "set-cookie" ? "\n" : ", ") + value;
}

/** The bytes of a binary input as a `Uint8Array`, without a copy. */
export function asBytes(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

let encoder: TextEncoder | undefined;

export function encodeUtf8(value: string) {
  return (encoder ??= new TextEncoder()).encode(value);
}

export function forEachField<Value>(
  fields: Fields<Value>,
  emit: (name: string, value: Value) => void,
): void {
  if (Array.isArray(fields)) {
    for (let i = 0; i < fields.length; i++) {
      const pair = fields[i]!;
      emit(pair[0], pair[1]);
    }

    return;
  }

  for (const name in fields) {
    const value = (fields as Record<string, Value | readonly Value[]>)[name];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        emit(name, value[i]);
      }
    } else {
      emit(name, value as Value);
    }
  }
}

const formEscapes = /[!'()~]/g;

function escapeFormCharacter(char: string) {
  return "%" + char.charCodeAt(0).toString(16).toUpperCase();
}

function encodeFormValue(value: string) {
  // URLSearchParams replaces unpaired UTF-16 surrogates before encoding.
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    encoded = encodeURIComponent(value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD"));
  }
  return encoded
    .replace(formEscapes, escapeFormCharacter)
    .replaceAll("%20", "+");
}

export function asSearchParams(fields: URLSearchParams | Fields<FieldScalar>) {
  if (fields instanceof URLSearchParams) {
    return fields;
  }

  const params = new URLSearchParams();

  forEachField(fields, (name, value) => {
    if (value !== undefined) {
      params.append(name, value === null ? "" : String(value));
    }
  });

  return params;
}

export function encodeFields(fields: QueryInput) {
  if (typeof fields === "string") {
    return fields;
  }

  if (typeof URLSearchParams !== "undefined") {
    return asSearchParams(fields).toString();
  }

  const items: string[] = [];

  forEachField(fields as Fields<FieldScalar>, (name, value) => {
    if (value !== undefined) {
      items.push(
        `${encodeFormValue(name)}=${encodeFormValue(value === null ? "" : String(value))}`,
      );
    }
  });

  return items.join("&");
}

export function encodeJson(body: unknown) {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    throw new TypeError("JSON body cannot be serialized");
  }

  return encoded;
}

/** Fetch `FormData` defaults for a file part. */
export const defaultFilename = "blob";
export const defaultFileMediaType = "application/octet-stream";

export function isMultipartFile(value: unknown): value is MultipartFile {
  return value !== null && typeof value === "object" && "data" in value;
}

export function asFormData(fields: MultipartInput) {
  if (fields instanceof FormData) {
    return fields;
  }

  const output = new FormData();

  forEachField(fields, (name, value) => {
    if (value === undefined) {
      return;
    }

    if (isMultipartFile(value)) {
      const blob = new Blob(
        [value.data as BlobPart],
        value.mediaType === undefined ? {} : { type: value.mediaType },
      );

      if (value.filename === undefined) {
        output.append(name, blob);
      } else {
        output.append(name, blob, value.filename);
      }
    } else {
      output.append(name, value === null ? "" : String(value));
    }
  });

  return output;
}

let decoder: TextDecoder | undefined;

export function decodeUtf8(input: ArrayBuffer | ArrayBufferView) {
  return (decoder ??= new TextDecoder()).decode(input);
}

function decodeFormValue(encoded: string) {
  const withSpaces = encoded.replaceAll("+", " ");
  if (!withSpaces.includes("%")) {
    return withSpaces;
  }

  try {
    return decodeURIComponent(withSpaces);
  } catch {
    // Match URLSearchParams by replacing malformed UTF-8.
    return withSpaces.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        const bytes = new Uint8Array(run.length / 3);
        for (let i = 0, at = 1; i < bytes.length; i++, at += 3) {
          bytes[i] = parseInt(run.slice(at, at + 2), 16);
        }

        // A BOM inside a form field is part of its value.
        return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      }
    });
  }
}

export function decodeUrlEncoded(text: string): UrlEncodedResponse {
  const result: Record<string, string | string[]> = Object.create(null);

  const pairs = (text.startsWith("?") ? text.slice(1) : text).split("&");
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    if (pair === "") {
      continue;
    }

    const equal = pair.indexOf("=");
    appendValue(
      result,
      decodeFormValue(equal < 0 ? pair : pair.slice(0, equal)),
      decodeFormValue(equal < 0 ? "" : pair.slice(equal + 1)),
    );
  }

  return result;
}

const multipartParameter = /;\s*([^=;\s]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^";\s]+))/g;

const quotedEscape = /\\(.)/g;
const partDisposition = /(?:^|\r\n)content-disposition:\s*([^\r\n]+)/i;
const partMediaType = /(?:^|\r\n)content-type:\s*([^\r\n]+)/i;
const endOfHeaders = new Uint8Array([13, 10, 13, 10]);

function parameterValue(match: RegExpExecArray) {
  const quoted = match[2];
  return quoted === undefined
    ? match[3]
    : quoted.includes("\\")
      ? quoted.replace(quotedEscape, "$1")
      : quoted;
}

export function decodeMultipart(
  bytes: Uint8Array,
  header: string | undefined,
): MultipartResponse {
  let boundaryValue: string | undefined;

  if (header !== undefined) {
    // Other multipart types have no field names, so match Fetch and reject
    // them.
    const mediaType = header.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType !== "multipart/form-data") {
      throw new TypeError("Multipart response is not multipart/form-data");
    }

    multipartParameter.lastIndex = 0;
    let match;
    while ((match = multipartParameter.exec(header)) !== null) {
      if (match[1]!.toLowerCase() === "boundary") {
        boundaryValue = parameterValue(match);
        break;
      }
    }
  }

  if (!boundaryValue) {
    throw new TypeError("Multipart boundary is missing");
  }

  const boundary = encodeUtf8("--" + boundaryValue);
  const lineBoundary = new Uint8Array(boundary.length + 2);
  lineBoundary[0] = 13;
  lineBoundary[1] = 10;
  lineBoundary.set(boundary, 2);

  const result: Record<string, MultipartResponseValue | MultipartResponseValue[]> =
    Object.create(null);

  function findBytes(needle: Uint8Array, start: number) {
    let position = start;

    while (position <= bytes.length - needle.length) {
      const candidate = bytes.indexOf(needle[0]!, position);
      if (candidate < 0 || candidate > bytes.length - needle.length) {
        return -1;
      }

      let i = 1;
      while (i < needle.length && bytes[candidate + i] === needle[i]) {
        i++;
      }

      if (i === needle.length) {
        return candidate;
      }

      position = candidate + 1;
    }

    return -1;
  }

  // Return the header offset, or zero for a closing delimiter.
  function afterDelimiter(at: number) {
    let next = at + boundary.length;
    const closing = bytes[next] === 45 && bytes[next + 1] === 45;
    if (closing) {
      next += 2;
    }

    while (bytes[next] === 32 || bytes[next] === 9) {
      next++;
    }

    if (bytes[next] === 13 && bytes[next + 1] === 10) {
      return closing ? 0 : next + 2;
    }

    return closing && next === bytes.length ? 0 : -1;
  }

  function findDelimiter(start: number) {
    let next = findBytes(lineBoundary, start);

    while (next >= 0) {
      const after = afterDelimiter(next + 2);
      if (after >= 0) {
        return { at: next, after };
      }

      next = findBytes(lineBoundary, next + 1);
    }
  }

  let at = findBytes(boundary, 0) === 0 ? afterDelimiter(0) : -1;
  if (at < 0) {
    at = findDelimiter(0)?.after ?? -1;
  }

  if (at < 0) {
    throw new TypeError("Multipart opening boundary is missing");
  }

  while (at > 0) {
    const headerEnd = findBytes(endOfHeaders, at);
    if (headerEnd < 0) {
      throw new TypeError("Multipart headers are malformed");
    }

    const headerText = decodeUtf8(bytes.subarray(at, headerEnd));
    const disposition = partDisposition.exec(headerText)?.[1];
    const mediaType = partMediaType.exec(headerText)?.[1];

    let name: string | undefined;
    let filename: string | undefined;

    if (disposition !== undefined) {
      multipartParameter.lastIndex = 0;
      let match;
      while ((match = multipartParameter.exec(disposition)) !== null) {
        switch (match[1]!.toLowerCase()) {
          case "name":
            name = parameterValue(match);
            break;
          case "filename":
            filename = parameterValue(match);
            break;
        }
      }
    }

    const bodyStart = headerEnd + endOfHeaders.length;
    const next = findDelimiter(bodyStart);
    if (next === undefined) {
      throw new TypeError("Multipart closing boundary is missing");
    }

    if (name !== undefined) {
      const data = bytes.subarray(bodyStart, next.at) as Uint8Array<ArrayBuffer>;
      appendValue(
        result,
        name,
        filename === undefined
          ? decodeUtf8(data)
          : mediaType === undefined
            ? { data, filename }
            : { data, filename, mediaType },
      );
    }

    at = next.after;
  }

  return result;
}
