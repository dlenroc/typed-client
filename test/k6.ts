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
  thresholds: { checks: ["rate==1"], completed: ["count==1"] },
};

const adapter = k6Transport({ baseUrl: __ENV.BASE_URL! });

async function jsonRequests() {
  let nativeTimings: Response["timings"] | undefined;
  const post = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      responses: { 200: c.type<Echo>(), 206: "binary" },
    }),
    k6Transport({
      baseUrl: __ENV.BASE_URL!,
      http: {
        file: http.file,
        async asyncRequest<Kind extends ResponseType | undefined>(
          ...args: Parameters<typeof http.asyncRequest<Kind>>
        ) {
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
}

async function formRequests() {
  const form = c.bind(
    c.endpoint("/echo", {
      method: "POST",
      body: "urlencoded",
      responses: { 200: c.type<Echo>() },
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
      body: "binary",
      responses: { 200: c.type<Echo>() },
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
      body: "multipart",
      responses: { 200: c.type<Echo>() },
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
      headers: {
        "content-type":
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
    headers: { "content-type": "multipart/form-data; boundary=caller" },
    unchecked: true,
  });
  check(malformed.body.headers, {
    "unchecked multipart preserves the supplied Content-Type": (headers) =>
      headers["content-type"] === "multipart/form-data; boundary=caller",
  });
}

async function responseDecoding() {
  const multipart = c.bind(
    c.endpoint("/multipart-tokens", { responses: { 200: "multipart" } }),
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

  const text = c.bind(
    c.endpoint("/bytes", { responses: { 200: "text", 206: "binary" } }),
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
          [status]: "json",
          206: "binary",
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

export default async function () {
  await jsonRequests();
  await formRequests();
  await binaryRequests();
  await multipartRequests();
  await responseDecoding();
  completed.add(1);
}
