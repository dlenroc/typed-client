import { describe, expect, onTestFinished, test, vi } from "vitest";
import { request, type APIRequestContext, type APIResponse } from "playwright-core";
import {
  c,
  type CommonOptions,
  type RequestKindMap,
  type ResponseKindMap,
  type Transport,
} from "@dlenroc/typed-client";
import { fetchTransport } from "@dlenroc/typed-client/fetch";
import { playwrightTransport } from "@dlenroc/typed-client/playwright";
import { schema, testWithServer, type Echo } from "./fixtures.ts";

const overHttp = [
  { name: "Fetch", create: (baseUrl: string) => fetchTransport({ baseUrl }) },
  {
    name: "Playwright",
    create: async (baseUrl: string) => {
      const context = await request.newContext();
      onTestFinished(() => context.dispose());
      return playwrightTransport({ baseUrl, context });
    },
  },
];

type HttpTransport = Transport<RequestKindMap, ResponseKindMap, CommonOptions, object>;

const method = "POST";
const responses = { 200: c.type<Echo>() };
const echoEndpoints = {
  json: c.endpoint("/echo", { method, responses }),
  text: c.endpoint("/echo", { method, body: "text", responses }),
  form: c.endpoint("/echo", { method, body: "urlencoded", responses }),
  multipart: c.endpoint("/echo", { method, body: "multipart", responses }),
  binary: c.endpoint("/echo", { method, body: "binary", responses }),
};

function bindEcho(transport: HttpTransport) {
  return c.bind(echoEndpoints, transport);
}

describe.each(overHttp)("$name over HTTP", ({ create }) => {
  const testHttp = testWithServer
    .extend("transport", async ({ baseUrl }): Promise<HttpTransport> => create(baseUrl))
    .extend("echo", ({ transport }) => bindEcho(transport));

  testHttp("send no body when omitted and encode null as JSON", async ({ echo }) => {
    const absent = await echo.json();
    expect(absent.body.body).toBe("");
    expect(absent.body.headers["content-type"]).toBeUndefined();

    const present = await echo.json({ body: null });
    expect(present.body.body).toBe("null");
    expect(present.body.headers["content-type"]).toBe("application/json");
  });

  testHttp("return a redirect unless asked to follow it", async ({ transport }) => {
    const get = c.bind(
      c.endpoint("/redirect", { responses: { 200: c.type<Echo>(), 302: "none" } }),
      transport,
    );

    const direct = await get();
    expect(direct.status).toBe(302);
    expect(direct.headers.location).toBe("/v1/echo");

    await expect(get({ follow: true })).resolves.toMatchObject({
      status: 200,
      body: { url: "/v1/echo" },
    });
  });

  testHttp("send Unicode JSON and preserve separate response cookies", async ({ echo }) => {
    const result = await echo.json({
      body: { name: "café" },
      headers: { "x-team": "identity" },
    });

    expect(result.body).toMatchObject({
      method: "POST",
      url: "/v1/echo",
      headers: { "x-team": "identity" },
      body: '{"name":"café"}',
    });
    expect(result.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  testHttp("preserve escaped and repeated query and form fields", async ({ echo }) => {
    const fields = {
      "name space": "café &+~!",
      tag: ["one", "two"],
      empty: null,
      absent: undefined,
    };
    const encoded = "name+space=caf%C3%A9+%26%2B%7E%21&tag=one&tag=two&empty=";
    const { body } = await echo.form({ query: fields, body: fields });

    expect(body).toMatchObject({
      url: `/v1/echo?${encoded}`,
      body: encoded,
      headers: {
        "content-type": expect.stringMatching(/^application\/x-www-form-urlencoded/),
      },
    });
    await expect(echo.form({ body: "already=encoded+input" })).resolves.toMatchObject({
      body: { body: "already=encoded+input" },
    });
  });

  testHttp.for(["application/json", "Application/JSON;charset=UTF-8"])(
    "send text verbatim under %s",
    async (contentType, { echo }) => {
      const { body } = await echo.text({
        body: "{bad café",
        headers: { "content-type": contentType },
      });

      expect(body).toMatchObject({
        body: "{bad café",
        headers: { "content-type": contentType },
      });
    },
  );

  testHttp.for([
    { shape: "record", view: "Uint8Array" },
    { shape: "pairs", view: "Uint8Array" },
    { shape: "record", view: "DataView" },
    { shape: "pairs", view: "DataView" },
  ] as const)(
    "encode multipart $shape with file defaults and the selected $view bytes",
    async ({ shape, view }, { echo }) => {
      const bytes = new Uint8Array([88, 65, 66, 89]);
      const data = view === "Uint8Array" ? bytes.subarray(1, 3) : new DataView(bytes.buffer, 1, 2);
      const file = { data };
      const input =
        shape === "record"
          ? { tag: "café", file }
          : ([
              ["tag", "café"],
              ["tag", "雪"],
              ["file", file],
            ] as const);
      const { body } = await echo.multipart({ body: input });
      const form = await echoedForm(body);
      const received = form.get("file");

      expect(form.getAll("tag")).toEqual(shape === "record" ? ["café"] : ["café", "雪"]);
      expect.assert(received instanceof File);
      expect(received).toMatchObject({ name: "blob", type: "application/octet-stream" });
      await expect(received.text()).resolves.toBe("AB");
      expect([...bytes]).toEqual([88, 65, 66, 89]);
    },
  );

  testHttp("send header names as given and keep the last spelling", async ({ echo }) => {
    const { body } = await echo.text({
      body: "x",
      headers: { "X-MiXeD": "1", "x-a": "first", "X-A": "last", "Content-Type": "text/csv" },
    });
    const pairs: string[] = [];
    for (let i = 0; i < body.rawHeaders.length; i += 2) {
      pairs.push(`${body.rawHeaders[i]}: ${body.rawHeaders[i + 1]}`);
    }

    expect(pairs).toEqual(
      expect.arrayContaining(["X-MiXeD: 1", "X-A: last", "Content-Type: text/csv"]),
    );
    expect(pairs.filter((pair) => /^(x-a|content-type):/i.test(pair))).toHaveLength(2);
  });

  testHttp("use the encoder's boundary for multipart headers", async ({ echo }) => {
    const body = { tag: "one" };
    const headers = { "content-type": "multipart/form-data; boundary=caller" };
    const supplied = await echo.multipart({ body, headers });
    const bare = await echo.multipart({ body, headers: { "content-type": "multipart/form-data" } });
    const spelled = await echo.multipart({
      body,
      headers: { "Content-Type": "multipart/form-data; boundary=caller" },
    });

    expect((await echoedForm(supplied.body)).get("tag")).toBe("one");
    expect((await echoedForm(bare.body)).get("tag")).toBe("one");
    expect((await echoedForm(spelled.body)).get("tag")).toBe("one");
    expect(headers).toEqual({ "content-type": "multipart/form-data; boundary=caller" });

    const malformed = await echo.multipart({ body, headers, unchecked: true });
    expect(malformed.body.headers["content-type"]).toBe("multipart/form-data; boundary=caller");
  });

  testHttp.for([
    { name: "Uint8Array", data: new Uint8Array([88, 65, 66, 89]).subarray(1, 3) },
    { name: "DataView", data: new DataView(new Uint8Array([88, 65, 66, 89]).buffer, 1, 2) },
  ])("send only the selected $name range", async ({ data }, { echo }) => {
    const { body } = await echo.binary({ body: data });
    expect(body.body).toBe("AB");
  });

  testHttp.for([
    { path: "/bytes", kind: "text", status: 200, expected: "\ufffd\ufffd" },
    { path: "/empty", kind: "none", status: 204, expected: undefined },
    {
      path: "/form",
      kind: "urlencoded",
      status: 200,
      expected: { tag: ["one", "two"], empty: "", bad: "\ufffd" },
    },
    { path: "/multipart", kind: "multipart", status: 200, expected: { note: "café 🏕" } },
  ] as const)(
    "decode a $kind response",
    async ({ path, kind, status, expected }, { transport }) => {
      const get = c.bind(
        c.endpoint(path, { responses: { [status]: kind } }),
        transport,
      );

      await expect(get({ status })).resolves.toMatchObject({ body: expected });
    },
  );

  testHttp("reject a multipart response that is not form-data", async ({ transport }) => {
    const get = c.bind(
      c.endpoint("/multipart-mixed", { responses: { 200: "multipart" } }),
      transport,
    );

    await expect(get()).rejects.toMatchObject({
      code: "response",
      schema: undefined,
      status: 200,
    });
  });

  testHttp("preserve every response byte", async ({ transport }) => {
    const get = c.bind(c.endpoint("/bytes", { responses: { 200: "binary" } }), transport);
    expect([...(await get()).body]).toEqual([0xe0, 0xa0, 0xff]);
  });

  testHttp("discard malformed JSON without decoding it", async ({ transport }) => {
    const get = c.bind(c.endpoint("/bad", { responses: { 200: "json" } }), transport);

    await expect(get()).rejects.toMatchObject({
      code: "response",
      schema: undefined,
      status: 200,
    });
    await expect(get({ discard: true })).resolves.toMatchObject({ body: undefined });
  });
});

describe("Fetch", () => {
  testWithServer("send a blob body with its type as the default Content-Type", async ({
    baseUrl,
  }) => {
    const upload = c.bind(
      c.endpoint("/echo", { method: "POST", body: "blob", responses: { 200: c.type<Echo>() } }),
      fetchTransport({ baseUrl }),
    );
    const body = new Blob(["café"], { type: "text/x-note" });

    const typed = await upload({ body });
    const replaced = await upload({ body, headers: { "content-type": "text/plain" } });
    const suppressed = await upload({ body, headers: { "content-type": null } });

    expect(typed.body).toMatchObject({ body: "café", headers: { "content-type": "text/x-note" } });
    expect(replaced.body.headers["content-type"]).toBe("text/plain");
    expect(suppressed.body.body).toBe("café");
    expect(suppressed.body.headers["content-type"]).toBeUndefined();
  });

  testWithServer("send a stream body without a default Content-Type", async ({
    baseUrl,
  }) => {
    const upload = c.bind(
      c.endpoint("/echo", { method: "POST", body: "stream", responses: { 200: c.type<Echo>() } }),
      fetchTransport({ baseUrl }),
    );
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("ca"));
        controller.enqueue(encoder.encode("fé"));
        controller.close();
      },
    });

    const result = await upload({ body });

    expect(result.body.body).toBe("café");
    expect(result.body.headers["transfer-encoding"]).toBe("chunked");
    expect(result.body.headers["content-type"]).toBeUndefined();
  });

  test("reuse native inputs and leave caller headers intact when adding a default", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const adapter = fetchTransport({ baseUrl: "https://api.test", fetch: send });
    const submit = c.bind(
      c.endpoint("/form", {
        method: "POST",
        body: "urlencoded",
        responses: { 204: "none" },
      }),
      adapter,
    );
    const upload = c.bind(
      c.endpoint("/files", {
        method: "POST",
        body: "multipart",
        responses: { 204: "none" },
      }),
      adapter,
    );
    const fields = "tag=one&tag=two";
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    const form = new FormData();

    await submit({ body: fields, headers });
    await upload({ body: form });

    const [, init] = send.mock.calls[0]!;
    expect(init?.body).toBe(fields);
    expect(send.mock.calls[1]?.[1]?.body).toBe(form);

    const defaults = { accept: "application/json" };
    await submit({ body: fields, headers: defaults });

    const prepared = new Headers(send.mock.calls[2]?.[1]?.headers);
    expect(prepared.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(prepared.get("accept")).toBe("application/json");
    expect(defaults).toEqual({ accept: "application/json" });
  });

  test("abort on the timeout or on the caller's signal, whichever comes first", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const get = c.bind(
      c.endpoint("/users", { responses: { 200: "json" } }),
      fetchTransport({ baseUrl: "https://api.test", fetch: send }),
    );

    await expect(get({ timeout: 5 })).rejects.toMatchObject({
      code: "transport",
      cause: { name: "TimeoutError" },
    });

    const reason = new Error("stop");
    const controller = new AbortController();
    const aborted = get({ timeout: 60_000, transport: { signal: controller.signal } });
    controller.abort(reason);
    await expect(aborted).rejects.toMatchObject({ code: "transport", cause: reason });
  });

  test("ignore request fields placed under transport", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const get = c.bind(
      c.endpoint("/users", { responses: { 204: "none" } }),
      fetchTransport({ baseUrl: "https://api.test", fetch: send }),
    );

    await get({ transport: { method: "POST", headers: { "x-a": "1" }, body: "x" } as object });

    const init = send.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "GET" });
    expect(init).not.toHaveProperty("headers");
    expect(init).not.toHaveProperty("body");
  });

  test("treat names that differ only in case as one header", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const get = c.bind(
      c.endpoint("/users", { responses: { 204: "none" } }),
      fetchTransport({ baseUrl: "https://api.test", fetch: send }),
    );

    await get({
      headers: { authorization: "default", "x-skip": undefined, Authorization: "caller", "x-n": 3 },
    });

    expect(send.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "caller", "x-n": "3" });
  });

  test.for([
    {
      name: "a later null suppresses the header and its default",
      headers: { "content-type": "text/csv", "Content-Type": null },
      expected: {},
    },
    {
      name: "a later undefined keeps the earlier spelling",
      headers: { "content-type": "text/csv", "Content-Type": undefined },
      expected: { "content-type": "text/csv" },
    },
    {
      name: "a later empty value replaces the default",
      headers: { "content-type": "text/csv", "Content-Type": "" },
      expected: { "Content-Type": "" },
    },
  ])("apply the header rules across spellings: $name", async ({ headers, expected }) => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const post = c.bind(
      c.endpoint("/users", { method: "POST", body: "text", responses: { 204: "none" } }),
      fetchTransport({ baseUrl: "https://api.test", fetch: send }),
    );

    await post({ body: "x", headers });

    expect(send.mock.calls[0]?.[1]?.headers).toEqual(expected);
  });

  testWithServer("suppress Content-Type for text, form, and multipart", async ({ baseUrl }) => {
    const adapter = fetchTransport({ baseUrl });
    const headers = { "content-type": null };
    const echo = bindEcho(adapter);

    const text = await echo.text({ body: "café \ud800x\udc00", headers });
    const form = await echo.form({ body: { note: "café" }, headers });
    const upload = await echo.multipart({ body: { note: "café" }, headers });

    expect(text.body.body).toBe("café \ufffdx\ufffd");
    expect(form.body.body).toBe("note=caf%C3%A9");
    expect(upload.body.body).toContain('name="note"\r\n\r\ncafé\r\n');
    for (const result of [text, form, upload]) {
      expect(result.body.headers["content-type"]).toBeUndefined();
    }
  });

  test("replay multipart fields through a retry wrapper", async () => {
    const attempts: { url: string; tags: FormDataEntryValue[] }[] = [];
    const adapter = fetchTransport({
      baseUrl: "/api",
      fetch: async (url, init) => {
        expect.assert(init?.body instanceof FormData);
        attempts.push({ url: String(url), tags: init.body.getAll("tag") });
        return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
      },
    });
    const retry: typeof adapter = async (input) => {
      const response = await adapter(input);
      if (response.status !== 503) {
        return response;
      }

      await response.read("none");
      return adapter(input);
    };
    const upload = c.bind(
      c.endpoint("/files", {
        method: "POST",
        body: "multipart",
        responses: { 204: "none" },
      }),
      retry,
    );

    await upload({
      body: [
        ["tag", "one"],
        ["tag", "two"],
      ],
    });

    expect(attempts).toEqual([
      { url: "/api/files", tags: ["one", "two"] },
      { url: "/api/files", tags: ["one", "two"] },
    ]);
  });

  test("return a readable Blob", async () => {
    const get = c.bind(
      c.endpoint("https://api.test/download", {
        responses: { 200: "blob" },
      }),
      fetchTransport({ fetch: async () => new Response("café") }),
    );

    const { body } = await get();

    expect(body).toBeInstanceOf(Blob);
    await expect(body.text()).resolves.toBe("café");
  });

  test("leave a returned stream unread for the caller", async () => {
    const native = new Response("café");
    const get = c.bind(
      c.endpoint("https://api.test/download", {
        responses: { 200: "stream" },
      }),
      fetchTransport({ fetch: async () => native }),
    );

    const { body } = await get();

    expect(body).toBe(native.body);
    expect(native.bodyUsed).toBe(false);
    await expect(new Response(body).text()).resolves.toBe("café");
  });

  test.each([false, true])("cancel a rejected stream (cancel fails: %s)", async (fails) => {
    const issues = [{ message: "Unexpected stream" }];
    const cleanupError = new Error("Cancel failed");
    const cancel = vi.fn(() => {
      if (fails) {
        throw cleanupError;
      }
    });
    const native = new Response(new ReadableStream({ cancel }));
    const get = c.bind(
      c.endpoint("https://api.test/download", {
        responses: { 200: { kind: "stream", schema: schema(() => ({ issues })) } },
      }),
      fetchTransport({ fetch: async () => native }),
    );

    const result = get();
    await expect(result).rejects.toMatchObject({
      code: "response",
      schema: "body",
      issues,
    });
    if (fails) {
      await expect(result).rejects.toHaveProperty("cleanupError", cleanupError);
    } else {
      await expect(result).rejects.not.toHaveProperty("cleanupError");
    }

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("Playwright", () => {
  testWithServer("return timing and the server address as metadata", async ({ baseUrl }) => {
    const context = await request.newContext();
    onTestFinished(() => context.dispose());
    const get = c.bind(
      c.endpoint("/empty", { responses: { 204: "none" } }),
      playwrightTransport({ context, baseUrl }),
    );

    const { transport } = await get();

    expect(transport?.serverAddr).toEqual({
      ipAddress: "127.0.0.1",
      port: Number(new URL(baseUrl).port),
    });
    expect(transport?.securityDetails).toBeNull();
    expect(transport?.timing.startTime).toBeGreaterThan(0);
  });

  testWithServer("decode multipart tokens and padded delimiters", async ({ baseUrl }) => {
    const context = await request.newContext();
    onTestFinished(() => context.dispose());
    const get = c.bind(
      c.endpoint("/multipart-tokens", { responses: { 200: "multipart" } }),
      playwrightTransport({ context, baseUrl }),
    );

    expect((await get()).body).toMatchObject({
      note: "one",
      file: {
        data: Buffer.from("AB\r\n--example--more"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
      },
    });
  });

  test("forward timeout, borrow binary buffers, and dispose the response", async () => {
    const input = Buffer.from("XABY").subarray(1, 3);
    const output = Buffer.from([1, 2, 3]);
    const dispose = vi.fn<APIResponse["dispose"]>().mockResolvedValue(undefined);
    const send = vi
      .fn<(...args: Parameters<APIRequestContext["fetch"]>) => Promise<APIResponse>>()
      .mockResolvedValue(nativeResponse({ body: async () => output, dispose }));
    const get = c.bind(
      c.endpoint("/bytes", {
        method: "POST",
        body: "binary",
        responses: { 200: "binary" },
      }),
      playwrightTransport({ context: { fetch: send } }),
    );

    const result = await get({ body: input, timeout: 1234, transport: { maxRetries: 2 } });

    expect(send).toHaveBeenCalledExactlyOnceWith(
      "/bytes",
      expect.objectContaining({ timeout: 1234, maxRedirects: 0, maxRetries: 2 }),
    );
    expect(send.mock.calls[0]?.[1]?.data).toBe(input);
    expect(result.body).toBe(output);
    expect(result.transport).toEqual({ timing: {}, serverAddr: null, securityDetails: null });
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  test.each([
    { stage: "setup", code: "transport", cause: "bad response headers" },
    { stage: "decode", code: "response", cause: Object.freeze(new Error("bad JSON")) },
    { stage: "dispose", code: "transport", cause: undefined },
  ])("classify $stage failures when disposal fails", async ({ stage, code, cause }) => {
    const cleanupError = new Error("dispose failed");
    const dispose = vi.fn<APIResponse["dispose"]>().mockRejectedValue(cleanupError);
    const response = nativeResponse({
      dispose,
      headersArray: () => {
        if (stage === "setup") {
          throw cause;
        }

        return [];
      },
      json: async () => {
        if (stage === "decode") {
          throw cause;
        }

        return {};
      },
    });
    const get = c.bind(
      c.endpoint("/users", { responses: { 200: "json" } }),
      playwrightTransport({ context: { fetch: async () => response } }),
    );

    await expect(get()).rejects.toMatchObject(
      stage === "dispose"
        ? { code, status: 200, cause: cleanupError }
        : { code, cause, cleanupError },
    );
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });
});

function echoedForm({ body, headers }: Echo) {
  const contentType = headers["content-type"];
  expect.assert(typeof contentType === "string");
  return new Response(body, { headers: { "content-type": contentType } }).formData();
}

function nativeResponse(
  fields: Pick<APIResponse, "dispose"> & Partial<APIResponse>,
): APIResponse {
  return {
    status: () => 200,
    url: () => "https://api.test/response",
    headersArray: () => [],
    timing: () => ({}) as ReturnType<APIResponse["timing"]>,
    serverAddr: async () => null,
    securityDetails: async () => null,
    ...fields,
  } as APIResponse;
}
