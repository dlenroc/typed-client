import { c } from "@dlenroc/typed-client";
import { k6Transport } from "@dlenroc/typed-client/k6";
import { routes } from "./routes.mjs";

const api = c.bind(routes, k6Transport());
export async function loadUser() {
  const result = await api.getUser({ path: { id: 7 } });
  if (result.status === 404) return result.body.message satisfies string;
  return result.body.id satisfies number;
}

// @ts-expect-error The emitted endpoint still requires its path.
void api.getUser();
