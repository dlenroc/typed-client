import type { Fields, FieldScalar, QueryInput } from "../core/types.js";

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
  return encodeURIComponent(value)
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
