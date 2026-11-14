import type { FieldScalar, HeaderInput } from "../core/types.js";
import { forEachField } from "../shared/fields.js";

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
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  let suppressedContentType = false;

  if (headers !== undefined) {
    function append(name: string, value: FieldScalar) {
      if (value === undefined) {
        return;
      }

      if (value === null) {
        delete result[name];

        if (name === "content-type") {
          suppressedContentType = true;
        }

        return;
      }

      if (name === "content-type") {
        suppressedContentType = false;
      }

      const text = String(value);
      const previous = result[name];

      if (previous === undefined) {
        result[name] = text;
      } else if (typeof previous === "string") {
        result[name] = [previous, text];
      } else {
        previous.push(text);
      }
    }

    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      headers.forEach((value, name) => append(name, value));
    } else {
      forEachField(headers as Exclude<HeaderInput, Headers>, (name, value) => {
        const key = name.toLowerCase();
        if (Array.isArray(value)) {
          for (const item of value) {
            append(key, item);
          }
        } else {
          append(key, value as FieldScalar);
        }
      });
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
