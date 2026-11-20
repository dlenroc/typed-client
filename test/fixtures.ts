import { test, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  c,
  type RequestKindMap,
  type ResponseHeaders,
  type ResponseKindMap,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";

export function schema<Result>(validate: (value: unknown) => Result) {
  type Output = Extract<Awaited<Result>, { value: unknown }>["value"];

  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
      types: {} as { input: unknown; output: Output },
    },
  } as const;
}

type FixtureResponses = Pick<ResponseKindMap, "json" | "none">;
type FixtureReadKind = keyof FixtureResponses | "text";
type ReadFixture = (kind: FixtureReadKind) => ResponseKindMap["json"] | undefined;

export function mockTransport<Options extends object = object>({
  status = 200,
  headers = {},
  read = (kind) => (kind === "json" ? { id: 7 } : undefined),
}: { status?: number; headers?: ResponseHeaders; read?: ReadFixture } = {}) {
  const decode = vi.fn(async (kind: FixtureReadKind) => read(kind));
  const response = {
    status,
    url: "https://api.test/users/7",
    headers,
    read: decode as Pick<typeof decode, "mock"> & TransportResponse<FixtureResponses>["read"],
  };
  const adapter = vi.fn(
    async (_request: TransportRequest<RequestKindMap, FixtureResponses, Options>) => response,
  );

  return { adapter, response };
}

export type Echo = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
};

export const testWithServer = test.extend("baseUrl", async ({}, { onCleanup }) => {
  const server = createServer(async (request, response) => {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const path = request.url?.split("?")[0];

    if (path === "/v1/slow") {
      setTimeout(() => response.end("{}"), 300);
    } else if (path === "/v1/bad") {
      response.end("{bad");
    } else if (path === "/v1/redirect") {
      response.writeHead(302, { location: "/v1/echo" }).end();
    } else if (path === "/v1/missing") {
      response.writeHead(404).end();
    } else if (path === "/v1/empty") {
      response.writeHead(204).end();
    } else if (path === "/v1/bytes") {
      response.end(Buffer.from([0xe0, 0xa0, 0xff]));
    } else if (path === "/v1/form") {
      response.setHeader("content-type", "application/x-www-form-urlencoded");
      response.end("tag=one&tag=two&empty=&bad=%FF&mixed=雪%FF&bom=%EF%BB%BF%FF");
    } else if (path === "/v1/multipart-tokens") {
      response.setHeader("content-type", 'multipart/form-data; boundary="example"');
      response.end(
        "--example-not-a-delimiter\r\n--example \t\r\n" +
          "Content-Disposition: form-data; name=note\r\n\r\none\r\n" +
          '--example\r\nContent-Disposition: form-data; name="file"; filename=a.bin\r\n' +
          "Content-Type: application/octet-stream\r\n\r\nAB\r\n--example--more\r\n" +
          "--example-- \t",
      );
    } else if (path === "/v1/multipart-mixed") {
      response.setHeader("content-type", "multipart/mixed; boundary=example");
      response.end(
        "--example\r\nContent-Type: text/plain\r\n\r\none\r\n--example--\r\n",
      );
    } else if (path === "/v1/multipart") {
      response.setHeader("content-type", "multipart/form-data; boundary=example");
      response.end(
        "--example\r\n" +
          'Content-Disposition: form-data; name="note"\r\n\r\n' +
          "café 🏕\r\n--example--\r\n",
      );
    } else {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.setHeader("x-repeated", ["a", "b"]);
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          headers: request.headers,
          rawHeaders: request.rawHeaders,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  onCleanup(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  return `http://127.0.0.1:${address.port}/v1`;
});

export type JsonOrNone = Pick<ResponseKindMap, "json" | "none">;

/** A Fetch transport with base URL `https://api.test/v1` that records each request. */
export function recorder() {
  const sent: { url: string; headers: unknown; init: RequestInit }[] = [];
  const transport = fetchTransport({
    baseUrl: "https://api.test/v1",
    fetch: async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers, init: init! });
      return new Response(null, { status: 204 });
    },
  });
  return { sent, transport };
}

// No cast: the decorator names the four type parameters of the transport.
export function withToken<Requests extends object, Responses extends object, Options, Metadata extends object>(
  next: Transport<Requests, Responses, Options, Metadata>,
  token: () => string | Promise<string>,
): Transport<Requests, Responses, Options, Metadata> {
  return async (request) =>
    next({ ...request, headers: { authorization: `Bearer ${await token()}`, ...request.headers } });
}

export const users = { get: c.endpoint("/users/{id}", { responses: { 204: c.none() } }) };
