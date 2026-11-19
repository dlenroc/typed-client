import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// Ask the TypeScript language server, as an editor does, for the completions
// at each `/*|name*/` position of the fixture.
async function completions(file: string): Promise<Record<string, string[]>> {
  const text = readFileSync(file, "utf8");
  const tsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
  const server = spawn(tsc, ["--lsp", "--stdio"], { cwd: fileURLToPath(new URL(".", import.meta.url)) });
  const pending = new Map<number, (result: unknown) => void>();
  let buffer = Buffer.alloc(0);
  let id = 0;

  server.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      if (message.method !== undefined && message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result: null });
      } else if (message.id !== undefined) {
        pending.get(message.id)?.(message.result);
      }
    }
  });

  function send(message: object) {
    const json = JSON.stringify(message);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  function request(method: string, params: object) {
    return new Promise<unknown>((resolve) => {
      pending.set(++id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  try {
    const uri = pathToFileURL(file).href;
    await request("initialize", { processId: process.pid, rootUri: pathToFileURL(file).href, capabilities: {} });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "typescript", version: 1, text } },
    });

    const labels: Record<string, string[]> = {};
    for (const marker of text.matchAll(/\/\*\|(\w+)\*\//g)) {
      const lines = text.slice(0, marker.index).split("\n");
      const result = (await request("textDocument/completion", {
        textDocument: { uri },
        position: { line: lines.length - 1, character: lines.at(-1)!.length },
      })) as { items?: { label: string }[] } | { label: string }[] | null;
      const items = Array.isArray(result) ? result : (result?.items ?? []);
      labels[marker[1]!] = items.map((item) => item.label.replace(/\?$/, "")).sort();
    }

    return labels;
  } finally {
    server.kill();
  }
}

test("the editor completes only the keys that a call or a declaration takes", { timeout: 60_000 }, async () => {
  const labels = await completions(fileURLToPath(new URL("./completions/fixture.ts", import.meta.url)));
  const call = ["body", "discard", "follow", "headers", "method", "path", "query", "status", "timeout", "transport"];

  expect(labels.call).toEqual(call);
  expect(labels.callPartial).toEqual(call);
  expect(labels.callLater).toEqual(call.filter((key) => key !== "path"));
  expect(labels.unionBranch).toEqual(call.filter((key) => key !== "path"));
  expect(labels.status).toContain("200");
  expect(labels.path).toEqual(["id"]);
  expect(labels.query).toEqual(["page"]);
  expect(labels.headers).toEqual(["token"]);
  expect(labels.body).toEqual(["name", "tags"]);
  expect(labels.storedRawBody).toEqual(["name", "tags"]);
  expect(labels.selectedBody).toEqual(["id"]);
  expect(labels.fetchOptions).toEqual([
    "cache", "credentials", "integrity", "keepalive", "mode", "priority", "redirect",
    "referrer", "referrerPolicy", "signal", "window",
  ]);
  expect(labels.playwrightOptions).toEqual(["ignoreHTTPSErrors", "maxRedirects", "maxRetries", "signal"]);
  expect(labels.k6Options).toEqual([
    "auth", "compression", "cookies", "jar", "redirects", "responseCallback", "tags", "timeout",
  ]);
  expect(labels.fetchRawKind).toEqual(["binary", "blob", "json", "multipart", "stream", "text", "urlencoded"]);
  expect(labels.playwrightRawKind).toEqual(["binary", "json", "multipart", "text", "urlencoded"]);
  expect(labels.definition).toEqual(["body", "headers", "meta", "method", "path", "query", "responses"]);
  expect(labels.response).toEqual(["body", "headers"]);
  expect(labels.responseLater).toEqual(["headers"]);
  expect(labels.kind).toEqual(expect.arrayContaining(["blob", "json", "none", "stream", "text"]));
});
