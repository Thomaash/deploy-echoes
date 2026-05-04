import { match, rejects, strictEqual } from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { list } from "tar";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

test("empty --archive-dir is rejected", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-empty-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "",
      "--compression",
      "none",
      "--keep",
      "1",
      "https://example.invalid",
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /empty/);
});

test("absolute --archive-dir is rejected and nothing is created on disk", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-absolute-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");
  const absolutePath = join(distDir, "absolute-target");

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      absolutePath,
      "--compression",
      "none",
      "--keep",
      "1",
      "https://example.invalid",
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, new RegExp(absolutePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  match(result.stderr, /relative/);
  await rejects(access(absolutePath), { code: "ENOENT" });
});

test("parent-traversing --archive-dir is rejected before filesystem mutation", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-traversal-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const distDir = join(rootDir, "dist");
  const escapedArchiveDir = join(rootDir, "escaped-archives");
  await mkdir(distDir);
  await mkdir(escapedArchiveDir);
  await writeFile(join(distDir, "index.html"), "<html>local</html>");
  await writeFile(join(escapedArchiveDir, "keep.txt"), "do not delete");

  const cdn = await startMockCdn({ archives: new Map<string, Buffer>() });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "../escaped-archives",
      "--compression",
      "none",
      "--keep",
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /must stay under --dist/);
  strictEqual(await readFile(join(distDir, "index.html"), "utf8"), "<html>local</html>");
  strictEqual((await readdir(escapedArchiveDir)).toSorted().join(","), "keep.txt");
  strictEqual(cdn.requestLog.length, 0, "invalid archive-dir should fail before any fetch");
});

test("root-collapsing --archive-dir is rejected before dist mutation", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-root-collapse-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  const localIndex = "<html>local</html>";
  const localAsset = "console.log('local');";
  await writeFile(join(distDir, "index.html"), localIndex);
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "assets", "app.js"), localAsset);

  const cdn = await startMockCdn({ archives: new Map<string, Buffer>() });
  t.after(() => cdn.close());

  const result = await runCli(
    ["--dist", distDir, "--archive-dir", "foo/..", "--compression", "none", "--keep", "1", cdn.url],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /cannot resolve to --dist itself/);
  strictEqual(await readFile(join(distDir, "index.html"), "utf8"), localIndex);
  strictEqual(await readFile(join(distDir, "assets", "app.js"), "utf8"), localAsset);
  strictEqual(
    (await readdir(distDir)).includes("0.tar"),
    false,
    "run must fail before createArchive",
  );
  strictEqual(cdn.requestLog.length, 0, "invalid archive-dir should fail before any fetch");
});

test("normalized descendant --archive-dir uses one canonical archive subdirectory", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-normalized-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "assets", "app.js"), "console.log('local');");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "gz" });
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar.gz", archive0]]),
  });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "release/../deploy-echoes",
      "--compression",
      "gz",
      "--keep",
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; got ${result.code}; stderr=${result.stderr}`);
  await access(join(distDir, "deploy-echoes", "0.tar.gz"));
  await access(join(distDir, "deploy-echoes", "1.tar.gz"));
  await access(join(distDir, "from-0.txt"));
  await rejects(access(join(distDir, "release")), { code: "ENOENT" });

  const entries: string[] = [];
  await list({
    file: join(distDir, "deploy-echoes", "0.tar.gz"),
    onentry: (entry) => {
      entries.push(entry.path.replace(/^\.\//, "").replace(/\/$/, ""));
    },
  });
  strictEqual(
    entries.some((entry) => entry === "deploy-echoes" || entry.startsWith("deploy-echoes/")),
    false,
    `archive should exclude its canonical archive directory; got: ${JSON.stringify(entries)}`,
  );
});

test("--archive-dir defaults to deploy-echoes", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-default-dir-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "gz" });
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar.gz", archive0]]),
  });
  t.after(() => cdn.close());

  const result = await runCli(["--dist", distDir, "--compression", "gz", "--keep", "1", cdn.url], {
    cwd: distDir,
  });

  strictEqual(result.code, 0, `expected exit 0; got ${result.code}; stderr=${result.stderr}`);
  await access(join(distDir, "deploy-echoes", "0.tar.gz"));
});

test("default --request-timeout permits a fast run to complete", async (t) => {
  // Proves the default timeout is non-zero-and-not-aggressive enough to abort a ~100 ms
  // response; src/cli-config.test.ts already pins the exact 30_000 ms default value.
  const distDir = await mkdtemp(
    join(tmpdir(), "deploy-echoes-e2e-cli-validation-timeout-default-"),
  );
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "gz" });
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar.gz", archive0]]),
  });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "old-files",
      "--compression",
      "gz",
      "--keep",
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; got ${result.code}; stderr=${result.stderr}`);
});

test("--request-timeout 5 enforces a 5-second deadline", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-timeout-5-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const cdn = await startMockCdn({
    archives: new Map<string, { delayMs: number }>([["0.tar.gz", { delayMs: 7000 }]]),
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
      "gz",
      "--keep",
      "1",
      "--request-timeout",
      "5",
      cdn.url,
    ],
    { cwd: distDir, timeoutMs: 10000 },
  );
  const elapsed = Date.now() - start;

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  strictEqual(elapsed <= 6500, true, `expected exit within 6500ms; took ${elapsed}ms`);
  match(
    result.stderr,
    new RegExp(`${cdn.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/0\\.tar\\.gz`),
  );
});

test("--request-timeout 0 disables the deadline", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-timeout-0-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "gz" });
  const cdn = await startMockCdn({
    archives: new Map<string, { delayMs: number; body: Buffer }>([
      ["0.tar.gz", { delayMs: 3000, body: archive0 }],
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
      "gz",
      "--keep",
      "1",
      "--request-timeout",
      "0",
      cdn.url,
    ],
    { cwd: distDir, timeoutMs: 10000 },
  );

  strictEqual(result.code, 0, `expected exit 0; got ${result.code}; stderr=${result.stderr}`);
});

test("--request-timeout 1.5 is rejected", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-timeout-1-5-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

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
      "1.5",
      "https://example.invalid",
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /--request-timeout/);
});

test("--request-timeout 30s is rejected", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-cli-validation-timeout-30s-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

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
      "30s",
      "https://example.invalid",
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /--request-timeout/);
});
