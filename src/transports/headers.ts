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

export interface PreparedHeaders {
  readonly fields: Record<string, string>;

  /** The `Content-Type` value in `fields`, if `fields` has it. */
  readonly contentType: string | undefined;

  /** The caller set `Content-Type` to `null`. */
  readonly contentTypeSuppressed: boolean;
}

/**
 * Merge names that differ only in case and add the default `Content-Type`.
 * A checked multipart body drops the caller's `Content-Type`, because the
 * encoder sets the boundary.
 */
export function prepareHeaders(
  headers: HeaderInput | undefined,
  bodyKind: string,
  bodyPresent: boolean,
  unchecked: boolean,
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
  if (bodyPresent && bodyKind === "multipart" && !unchecked) {
    if (contentTypeName !== undefined) {
      delete fields[contentTypeName];
      contentType = undefined;
    }
  } else if (bodyPresent && contentType === undefined && !contentTypeSuppressed) {
    contentType = defaultContentType(bodyKind);
    if (contentType !== undefined) {
      fields["content-type"] = contentType;
    }
  }

  return { fields, contentType, contentTypeSuppressed };
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
