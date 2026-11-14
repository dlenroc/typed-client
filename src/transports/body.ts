import type { BinaryInput, MultipartInput } from "../core/types.js";
import { RequestPreparationError } from "../core/errors.js";
import { forEachField } from "../shared/fields.js";

export function encodeJson(body: unknown) {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    throw new RequestPreparationError("JSON body cannot be serialized");
  }

  return encoded;
}

export function binaryView(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
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
      const bytes = binaryView(value.data);
      const blob = new Blob(
        [bytes as BlobPart],
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
