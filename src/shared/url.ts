import type { QueryInput } from "../core/types.js";
import { encodeFields } from "./fields.js";

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

export function createUrlResolver(baseUrl: string | undefined): (path: string) => string {
  if (baseUrl === undefined) {
    return (path) => path;
  }

  const prefix = baseUrl.replace(/\/+$/, "");

  return (path) => {
    if (path.charCodeAt(0) === 47) {
      return path.charCodeAt(1) === 47 ? path : prefix + path;
    }

    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) ? path : prefix + "/" + path;
  };
}
