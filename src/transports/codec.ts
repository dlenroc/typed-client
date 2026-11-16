import type {
  MultipartResponse,
  MultipartResponseValue,
  UrlEncodedResponse,
} from "../core/types.js";

let encoder: TextEncoder | undefined;
let decoder: TextDecoder | undefined;

export function encodeUtf8(value: string) {
  return (encoder ??= new TextEncoder()).encode(value);
}

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

        return decodeUtf8(bytes);
      }
    });
  }
}

export function decodeUrlEncoded(text: string): UrlEncodedResponse {
  const result: Record<string, string | string[]> = Object.create(null);

  function add(key: string, value: string) {
    const previous = result[key];
    if (previous === undefined) {
      result[key] = value;
    } else if (typeof previous === "string") {
      result[key] = [previous, value];
    } else {
      previous.push(value);
    }
  }

  if (typeof URLSearchParams !== "undefined") {
    for (const [key, value] of new URLSearchParams(text)) {
      add(key, value);
    }
  } else {
    const raw = text.startsWith("?") ? text.slice(1) : text;
    const pairs = raw.split("&");
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      if (pair === "") {
        continue;
      }

      const equal = pair.indexOf("=");
      add(
        decodeFormValue(equal < 0 ? pair : pair.slice(0, equal)),
        decodeFormValue(equal < 0 ? "" : pair.slice(equal + 1)),
      );
    }
  }

  return result;
}

const multipartParameter = /;\s*([^=;\s]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^";\s]+))/g;

function parameterValue(match: RegExpExecArray) {
  const quoted = match[2];
  return quoted === undefined
    ? match[3]
    : quoted.includes("\\")
      ? quoted.replace(/\\(.)/g, "$1")
      : quoted;
}

export function decodeMultipart(
  bytes: Uint8Array,
  contentType: string | readonly string[] | undefined,
): MultipartResponse {
  const header = typeof contentType === "string" ? contentType : contentType?.[0];
  let boundaryValue: string | undefined;
  if (header !== undefined) {
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

  const endOfHeaders = new Uint8Array([13, 10, 13, 10]);
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
    const disposition = /(?:^|\r\n)content-disposition:\s*([^\r\n]+)/i.exec(headerText)?.[1];
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
    const mediaType = /(?:^|\r\n)content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1];
    const bodyStart = headerEnd + endOfHeaders.length;

    const next = findDelimiter(bodyStart);
    if (next === undefined) {
      throw new TypeError("Multipart closing boundary is missing");
    }

    if (name !== undefined) {
      const data = bytes.subarray(bodyStart, next.at);
      const value: MultipartResponseValue =
        filename === undefined
          ? decodeUtf8(data)
          : { data, filename, ...(mediaType === undefined ? {} : { mediaType }) };
      const previous = result[name];
      if (previous === undefined) {
        result[name] = value;
      } else if (Array.isArray(previous)) {
        previous.push(value);
      } else {
        result[name] = [previous, value];
      }
    }

    at = next.after;
  }

  return result;
}
