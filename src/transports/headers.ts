import type { HeaderInput } from "../core/types.js";

export function defaultContentType(bodyKind: string) {
  switch (bodyKind) {
    case "json":
      return "application/json";
    case "text":
      return "text/plain; charset=UTF-8";
    case "urlencoded":
      return "application/x-www-form-urlencoded";
  }
}

export function prepareHeaders(
  headers: HeaderInput | undefined,
  bodyKind: string,
  bodyPresent: boolean,
  contentTypeSuppressed: (suppressed: boolean) => void,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let suppressedContentType = false;

  if (headers !== undefined) {
    for (const name in headers) {
      const value = headers[name];
      if (value === undefined) {
        continue;
      }

      const key = name.toLowerCase();
      if (value === null) {
        delete result[key];
      } else {
        result[key] = String(value);
      }

      if (key === "content-type") {
        suppressedContentType = value === null;
      }
    }
  }

  if (bodyPresent && result["content-type"] === undefined && !suppressedContentType) {
    const contentType = defaultContentType(bodyKind);
    if (contentType !== undefined) {
      result["content-type"] = contentType;
    }
  }

  contentTypeSuppressed(suppressedContentType);

  return result;
}

export function appendResponseHeader(
  target: Record<string, string | string[]>,
  name: string,
  value: string,
): void {
  const key = name.toLowerCase();
  const previous = target[key];

  if (previous === undefined) {
    target[key] = value;
  } else if (typeof previous === "string") {
    target[key] = [previous, value];
  } else {
    previous.push(value);
  }
}
