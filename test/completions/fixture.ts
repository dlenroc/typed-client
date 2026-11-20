// Completion positions for `completions.test.ts`. `/*|name*/` marks a position.
import { c } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { k6Transport } from "@dlenroc/typed-client/k6";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import type { APIRequestContext } from "playwright-core";

declare const context: APIRequestContext;
declare const flag: boolean;

const endpoint = c.endpoint("/users/{id}", {
  method: "POST",
  query: c.type<{ page?: number }>(),
  headers: c.type<{ token: string }>(),
  body: c.json<{ name: string; tags?: string[] }>(),
  responses: { 200: c.json<{ id: number }>(), 404: c.none() },
});

const fetchCall = c.bind(endpoint, fetchTransport());
const playwrightCall = c.bind(endpoint, playwrightTransport({ context }));
const k6Call = c.bind(endpoint, k6Transport());

void fetchCall({ /*|call*/ });
void fetchCall({ p/*|callPartial*/ });
void fetchCall({ status: /*|status*/ });
void fetchCall({ path: { id: 1 }, /*|callLater*/ });
void fetchCall({ path: { /*|path*/ } });
void fetchCall({ path: { id: 1 }, query: { /*|query*/ } });
void fetchCall({ path: { id: 1 }, headers: { /*|headers*/ } });
void fetchCall({ path: { id: 1 }, body: { /*|body*/ } });

void fetchCall({ path: { id: 1 }, transport: { /*|fetchOptions*/ } });
void playwrightCall({ path: { id: 1 }, transport: { /*|playwrightOptions*/ } });
void k6Call({ path: { id: 1 }, transport: { t/*|k6Options*/ } });
void fetchCall({ path: { id: 1 }, body: c.raw("x", "/*|fetchRawKind*/") });
void playwrightCall({ path: { id: 1 }, body: c.raw("x", "/*|playwrightRawKind*/") });
void fetchCall(flag ? { path: { id: 1 }, /*|unionBranch*/ } : { path: { id: 2 }, status: 404 });

c.endpoint("/x", { /*|definition*/ });
c.endpoint("/x", { responses: { 200: { /*|response*/ } } });
c.endpoint("/x", { responses: { 200: { body: c.none(), /*|responseLater*/ } } });
c.endpoint("/x", { body: c.kind("/*|kind*/") });

const rawId = c.raw("a/b");
void fetchCall({ path: { id: rawId }, body: { /*|storedRawBody*/ } });
const selected = await fetchCall({
  path: { id: rawId },
  headers: { token: "test" },
  body: { name: "Ada" },
  status: 200,
});
void selected.body./*|selectedBody*/;
