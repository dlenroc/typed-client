// Representative generator output. Each endpoint keeps its literal template and statuses.
import { c, type Endpoint } from "@dlenroc/typed-client";

export const routes = {
  getUser: c.endpoint("/users/{id}", {
    responses: { 200: c.json<{ id: number }>(), 404: c.json<{ message: string }>() },
  }),
} satisfies Record<string, Endpoint>;
