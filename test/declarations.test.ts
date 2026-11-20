import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("consumers can emit declarations for contracts and inferred adapter results", () => {
  const output = mkdtempSync(join(tmpdir(), "typed-client-emit-"));
  try {
    const tsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
    const fixture = fileURLToPath(new URL("./declarations/consumer.ts", import.meta.url));

    execFileSync(tsc, [
      "--ignoreConfig", "--strict", "--rootDir", ".", "--types", "node",
      "--module", "NodeNext", "--target", "ES2022",
      "--declaration", "--emitDeclarationOnly", "--outDir", output, fixture,
    ], { stdio: "inherit" });
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
});

test("a k6 consumer can bind emitted contract declarations without DOM or Node globals", () => {
  const output = mkdtempSync(join(tmpdir(), "typed-client-contract-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const tsc = join(root, "node_modules/.bin/tsc");
    const fixtures = join(root, "test/declarations");
    const options = [
      "--ignoreConfig", "--strict", "--lib", "ES2022", "--types", "k6",
      "--module", "NodeNext", "--target", "ES2022",
    ];

    execFileSync(tsc, [
      ...options, "--declaration", "--emitDeclarationOnly",
      "--rootDir", fixtures, "--outDir", output, join(fixtures, "routes.mts"),
    ], { stdio: "inherit" });

    // The consumer resolves the installed package and the emitted .d.mts only.
    const modules = join(output, "node_modules");
    mkdirSync(join(modules, "@dlenroc"), { recursive: true });
    symlinkSync(root, join(modules, "@dlenroc/typed-client"), "junction");
    symlinkSync(join(root, "node_modules/@types"), join(modules, "@types"), "junction");
    copyFileSync(join(fixtures, "k6.mts"), join(output, "k6.mts"));

    execFileSync(tsc, [...options, "--noEmit", "k6.mts"], { cwd: output, stdio: "inherit" });
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
});
