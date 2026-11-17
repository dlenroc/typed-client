import type { MultipartInput } from "../core/types.js";
import { forEachField } from "../shared/fields.js";

export function encodeJson(body: unknown) {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    throw new TypeError("JSON body cannot be serialized");
  }

  return encoded;
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

    if (value !== null && typeof value === "object" && "data" in value) {
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
