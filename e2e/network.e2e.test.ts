import { strictEqual, match } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

test("HTTP 500 at index 1 stops fetching and surfaces URL+status in stderr", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-net-500-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "none" });
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer | { status: number }>([
      ["0.tar", archive0],
      ["1.tar", { status: 500 }],
    ]),
  });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "old-files",
      "--compression",
      "none",
      "--keep",
      "5",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, new RegExp(`${cdn.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/1\\.tar`));
  match(result.stderr, /HTTP 500/);

  const requestPaths = cdn.requestLog.map((e) => e.path);
  strictEqual(
    requestPaths.includes("/2.tar"),
    false,
    `should not request /2.tar after 500; log=${requestPaths.join(",")}`,
  );
});

test("--request-timeout 1 aborts a hanging response within ~1s", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-net-timeout-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const cdn = await startMockCdn({
    archives: new Map<string, { delayMs: number }>([["0.tar", { delayMs: 60000 }]]),
  });
  t.after(() => cdn.close());

  const start = Date.now();
  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "old-files",
      "--compression",
      "none",
      "--keep",
      "1",
      "--request-timeout",
      "1",
      cdn.url,
    ],
    { cwd: distDir, timeoutMs: 5000 },
  );
  const elapsed = Date.now() - start;

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  strictEqual(elapsed <= 4000, true, `expected exit within 4s; took ${elapsed}ms`);
  match(result.stderr, new RegExp(`${cdn.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/0\\.tar`));
});

test("connection refused: stderr contains URL and exit is non-zero", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-net-refused-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const cdn = await startMockCdn({ archives: new Map<string, Buffer>() });
  const url = cdn.url;
  await cdn.close();

  const result = await runCli(
    ["--dist", distDir, "--archive-dir", "old-files", "--compression", "none", "--keep", "1", url],
    { cwd: distDir, timeoutMs: 10000 },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/0\\.tar`));
});
