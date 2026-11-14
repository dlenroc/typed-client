import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { testWithServer } from "./fixtures.ts";

testWithServer("k6 sends and decodes requests over HTTP", { timeout: 30_000 }, async ({
  baseUrl,
  signal,
}) => {
  const script = fileURLToPath(new URL("./k6.ts", import.meta.url));
  const child = spawn(
    process.env.K6_BIN || "k6",
    ["run", "--quiet", "--no-usage-report", script],
    { env: { ...process.env, BASE_URL: baseUrl }, signal },
  );

  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const [code] = await once(child, "close");
  expect(code, output).toBe(0);
});
