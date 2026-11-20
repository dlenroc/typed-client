// A downstream package exporting its contract, operations, and inferred responses.
import { c, type InferInput, type InferResponse } from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { k6Transport } from "@dlenroc/typed-client/k6";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import type { APIRequestContext } from "playwright-core";

declare const context: APIRequestContext;

export const contract = c.endpoint("/users/{id}", { responses: { 200: c.json<{ name: string }>() } });
export type UserInput = InferInput<typeof contract>;
export type User = InferResponse<typeof contract, 200>["body"];

export const rawId = c.raw("a/b");
export const get = c.bind(contract, fetchTransport());
export const fromFetch = () => get({ path: { id: rawId } });
export const fromPlaywright = () => c.bind(contract, playwrightTransport({ context }))({ path: { id: 1 } });
export const fromK6 = () => c.bind(contract, k6Transport())({ path: { id: 1 } });
