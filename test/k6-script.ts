import { check } from "k6";
import { Counter } from "k6/metrics";
import http, { type Response, type ResponseType } from "k6/http";
import type { Echo } from "./fixtures.ts";
import { c, ClientError } from "../dist/index.js";
import { k6Transport } from "../dist/k6.js";

const completed = new Counter("completed");

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate==1"],
    completed: ["count==1"],
    "http_req_failed{name:expected}": ["rate==0"],
    "http_req_failed{name:unexpected}": ["rate==1"],
  },
};

const adapter = k6Transport({ baseUrl: __ENV.BASE_URL! });

async function jsonRequests() {
  let nativeTimings: Response["timings"] | undefined;
  const nativeTags: (Record<string, string> | undefined)[] = [];
  const post = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      body: c.json(),
      responses: { 200: c.json<Echo>(), 206: c.binary() },
    }),
    k6Transport({
      baseUrl: __ENV.BASE_URL!,
      http: {
        file: http.file,
        async asyncRequest<Kind extends ResponseType | undefined>(
          ...args: Parameters<typeof http.asyncRequest<Kind>>
        ) {
          nativeTags.push(args[3]?.tags as Record<string, string> | undefined);
          const response = await http.asyncRequest<Kind>(...args);
          nativeTimings = response.timings;
          return response;
        },
      },
    }),
  );
  const json = await post({ body: { name: "café" } });

  check(json, {
    "binary capture decodes a Unicode JSON exchange": (value) =>
      value.status === 200 && value.body.body === '{"name":"café"}',
  });
  check(json.transport?.timings, {
    "timings are detached from the native response": (timings) =>
      nativeTimings !== undefined &&
      timings !== nativeTimings &&
      timings?.duration === nativeTimings.duration,
  });

  await post({ body: null, transport: { tags: { name: "custom", step: "two" } } });
  check(nativeTags, {
    "the resolved template names the metric": (tags) =>
      tags[0]?.name === `${__ENV.BASE_URL!}/echo`,
    "a name tag of the caller wins": (tags) =>
      tags[1]?.name === "custom" && tags[1].step === "two",
  });
}

async function formRequests() {
  const form = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      body: c.urlencoded(),
      responses: { 200: c.json<Echo>() },
    }),
    adapter,
  );
  const fields = { "name space": "café &+~!", tag: ["one", "two"], blank: null };
  const encoded = "name+space=caf%C3%A9+%26%2B%7E%21&tag=one&tag=two&blank=";
  const result = await form({ query: fields, body: fields });

  check(result.body, {
    "form fields preserve escaping and repetition": (value) => value.body === encoded,
    "query fields use the same encoding": (value) => value.url === `/v1/echo?${encoded}`,
  });
}

async function binaryRequests() {
  const binary = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      body: c.binary(),
      responses: { 200: c.json<Echo>() },
    }),
    adapter,
  );
  const bytes = new Uint8Array([88, 65, 66, 89]);

  for (const [name, body, expected] of [
    ["ArrayBuffer", bytes.buffer.slice(1, 3), "AB"],
    ["Uint8Array", bytes.subarray(1, 3), "AB"],
    ["DataView", new DataView(bytes.buffer, 1, 2), "AB"],
    ["Uint16Array", new Uint16Array(bytes.buffer).subarray(1), "BY"],
  ] as const) {
    const response = await binary({ body });

    check(response.body.body, {
      [`${name} sends only its selected bytes`]: (value) => value === expected,
    });
  }
}

async function multipartRequests() {
  const upload = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      body: c.multipart(),
      responses: { 200: c.json<Echo>() },
    }),
    adapter,
  );

  const bytes = new Uint8Array([88, 65, 66, 89]);
  const file = { data: bytes.subarray(1, 3) };
  const record = { tag: "café", file };
  const pairs = [
    ["tag", "café"],
    ["tag", "雪"],
    ["file", file],
  ] as const;

  for (const [encoding, body, tags] of [
    ["native", record, ["café"]],
    ["manual", pairs, ["café", "雪"]],
  ] as const) {
    const result = await upload({
      body,
      // Both cases also check a Content-Type name with another spelling.
      headers: {
        "Content-Type":
          encoding === "native" ? "multipart/form-data" : "multipart/form-data; boundary=caller",
      },
    });
    const contentType = result.body.headers["content-type"];

    check(result.body.body, {
      [`${encoding} multipart header matches the body boundary`]: (value) => {
        const boundary = /^multipart\/form-data; boundary=(\S+)$/.exec(String(contentType))?.[1];
        return boundary !== undefined && value.startsWith(`--${boundary}\r\n`);
      },
      [`${encoding} multipart sends the selected bytes and file defaults`]: (value) =>
        value.includes("\r\n\r\nAB\r\n") &&
        value.includes('filename="blob"') &&
        /application\/octet-stream/i.test(value),
      [`${encoding} multipart preserves every tag`]: (value) =>
        (value.match(/name="tag"/g) ?? []).length === tags.length &&
        tags.every((tag) => value.includes(`name="tag"\r\n\r\n${tag}\r\n`)),
    });
  }

  for (const repeated of [false, true]) {
    const parts = [
      ["z-first", "café"],
      ["a-file", file],
      [repeated ? "z-first" : "m-last", "雪"],
    ] as const;
    const result = await upload({ body: parts });
    const wireParts = Array.from(
      result.body.body.matchAll(/Content-Disposition: form-data; name="([^"]+)"[^\r]*\r\n(?:Content-Type:[^\r]*\r\n)?\r\n([^\r]*)\r\n/gi),
      ([, name, value]) => [name, value],
    );

    check(wireParts, {
      [`ordered multipart pairs preserve names and bytes (repeated: ${repeated})`]: (actual) =>
        JSON.stringify(actual) === JSON.stringify([
          ["z-first", "café"], ["a-file", "AB"], [repeated ? "z-first" : "m-last", "雪"],
        ]),
    });
  }

  const nativeFile = await upload({
    body: [
      ["file", http.file("café", "note.txt", "text/plain")],
      ["file", http.file("雪", "snow.txt", "text/plain")],
    ],
  });

  check(nativeFile.body.body, {
    "repeated native files preserve first filename": (value) =>
      value.includes('filename="note.txt"'),
    "repeated native files preserve second filename": (value) =>
      value.includes('filename="snow.txt"'),
    "repeated native files preserve Unicode": (value) =>
      value.includes("café") && value.includes("雪"),
  });

  const suppressed = await upload({
    body: { note: "café" },
    headers: { "content-type": null },
  });

  check(suppressed.body, {
    "multipart Content-Type suppression is respected": (value) =>
      value.headers["content-type"] === undefined,
    "suppressed multipart keeps field bytes": (value) => value.body.includes("\r\n\r\ncafé\r\n"),
  });

  const malformed = await upload({
    body: pairs,
    headers: c.raw({ "content-type": "multipart/form-data; boundary=caller" }),
  });
  check(malformed.body.headers, {
    "raw headers keep the supplied multipart Content-Type": (headers) =>
      headers["content-type"] === "multipart/form-data; boundary=caller",
  });
}

async function redirects() {
  const get = c.bind(
    c.endpoint("/redirect", { responses: { 200: c.json<Echo>(), 302: c.none() } }),
    adapter,
  );

  check(await get(), {
    "a redirect is returned by default": (value) =>
      value.status === 302 && value.headers.location === "/v1/echo",
  });
  check(await get({ follow: true }), {
    "follow returns the final response": (value) => value.status === 200,
  });
  check(await get({ transport: { redirects: 1 } }), {
    "a native redirect count overrides the default": (value) => value.status === 200,
  });
}

async function responseDecoding() {
  const multipart = c.bind(
    c.endpoint("/multipart-tokens", { responses: { 200: c.multipart() } }),
    adapter,
  );
  check((await multipart()).body, {
    "multipart decodes tokens and padded delimiters": ({ note, file }) =>
      note === "one" &&
      typeof file === "object" &&
      "data" in file &&
      file.filename === "a.bin" &&
      new TextDecoder().decode(file.data) === "AB\r\n--example--more",
  });

  const refused = c.bind(c.endpoint("http://127.0.0.1:1/", { responses: {} }), adapter);
  const slow = c.bind(c.endpoint("/slow", { responses: { 200: c.json() } }), adapter);
  for (const [name, call, code] of [
    ["a refused connection", () => refused({ status: 200 }), "transport"],
    ["a timeout", () => slow({ timeout: 50 }), "timeout"],
  ] as const) {
    const error = await call().then(() => undefined, (cause: unknown) => cause);
    check(error, {
      [`${name} is a ${code} error`]: (value) =>
        value instanceof ClientError && value.code === code,
      [`${name} keeps the k6 error code`]: (value) =>
        value instanceof ClientError &&
        typeof (value.cause as { code?: unknown }).code === "number" &&
        (code === "transport" || (value.cause as { code: number }).code === 1050),
    });
  }

  for (const [name, kind, body] of [
    ["captured", "text", "{bad"],
    ["not captured", "none", undefined],
  ] as const) {
    const bad = c.bind(c.endpoint("/bad", { responses: { 204: c.kind(kind) } }), adapter);
    const error = await bad().then(() => undefined, (cause: unknown) => cause);
    check(error, {
      [`a status error has the ${name} body`]: (value) =>
        value instanceof ClientError && value.code === "status" && value.body === body,
    });
  }

  const empty = c.bind(c.endpoint("/empty", { responses: { 204: c.none() } }), adapter);
  check(await empty(), {
    "metadata has the remote port and empty TLS data over HTTP": (value) =>
      value.transport?.remote_port === Number(/:(\d+)/.exec(__ENV.BASE_URL!)?.[1]) &&
      value.transport.tls_version === "" &&
      value.transport.tls_cipher_suite === "",
  });

  const mixed = c.bind(
    c.endpoint("/multipart-mixed", { responses: { 200: c.multipart() } }),
    adapter,
  );
  let mixedError: unknown;

  try {
    await mixed();
  } catch (cause) {
    mixedError = cause;
  }

  check(mixedError, {
    "multipart/mixed is rejected": (value) =>
      value instanceof ClientError && value.code === "response" && value.schema === undefined,
  });

  const text = c.bind(
    c.endpoint("/bytes", { responses: { 200: c.text(), 206: c.binary() } }),
    adapter,
  );

  check((await text()).body, {
    "binary-captured text replaces malformed UTF-8": (value) => value === "\ufffd\ufffd",
  });

  for (const [path, status] of [
    ["/bad", 200],
    ["/empty", 204],
  ] as const) {
    const get = c.bind(
      c.endpoint(path, {
        responses: {
          [status]: c.json(),
          206: c.binary(),
        },
      }),
      adapter,
    );
    let error: unknown;

    try {
      await get();
    } catch (cause) {
      error = cause;
    }

    check(error, {
      [`${path} JSON failure is classified`]: (value) =>
        value instanceof ClientError && value.code === "response" && value.schema === undefined,
    });
    check((await get({ discard: true })).body, {
      [`${path} JSON decoding can be discarded`]: (value) => value === undefined,
    });
  }
}

async function expectedStatuses() {
  const callbacks: unknown[] = [];
  const capture: unknown[] = [];
  const missing = c.bind(
    c.endpoint("/missing", { responses: { 404: c.none(), 201: c.binary() } }),
    k6Transport({
      baseUrl: __ENV.BASE_URL!,
      http: {
        file: http.file,
        asyncRequest<Kind extends ResponseType | undefined>(
          ...args: Parameters<typeof http.asyncRequest<Kind>>
        ) {
          callbacks.push(args[3]?.responseCallback);
          capture.push(args[3]?.responseType);
          return http.asyncRequest<Kind>(...args);
        },
      },
    }),
  );
  const own = http.expectedStatuses(404);

  await missing({ status: 404, transport: { tags: { name: "expected" } } });
  await missing({ status: [404], transport: { tags: { name: "expected" } } });
  await missing({ status: 404, transport: { tags: { name: "expected" } } });
  await missing({ status: 200, transport: { responseCallback: own } }).catch(() => {});
  await missing({ transport: { tags: { name: "unexpected" } } });

  check(capture, {
    "a selected bodyless or undeclared status skips capture": (values) =>
      values.slice(0, 4).every(value => value === "none"),
    "an omitted status includes declared binary bodies": (values) => values[4] === "binary",
  });
  check(callbacks, {
    "an expected status sets a response callback": (value) => value[0] !== undefined,
    "the callback is created once per status value": (value) =>
      value[0] === value[2] && value[0] !== value[1],
    "a response callback of the caller wins": (value) => value[3] === own,
    "a call without status sets no callback": (value) => value[4] === undefined,
  });
}

export default async function () {
  await jsonRequests();
  await formRequests();
  await binaryRequests();
  await multipartRequests();
  await redirects();
  await responseDecoding();
  await expectedStatuses();
  completed.add(1);
}
