import { strictEqual, match } from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

test("primary gz with tar fallback: mixed availability across the chain", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-migration-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "gz" });
  const archive1 = await makeTarFromTree({ "from-1.txt": "from-1" }, { compression: "none" });
  const archive2gz = await makeTarFromTree({ "from-2.txt": "from-2" }, { compression: "gz" });
  const archive2tar = await makeTarFromTree(
    { "from-2-fallback.txt": "from-2-fallback" },
    { compression: "none" },
  );

  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([
      ["0.tar.gz", archive0],
      ["1.tar", archive1],
      ["2.tar.gz", archive2gz],
      ["2.tar", archive2tar],
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
      "--decompression-fallback",
      "none",
      "--keep",
      "5",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  const requestPaths = cdn.requestLog.map((e) => e.path);
  strictEqual(requestPaths.includes("/0.tar.gz"), true);
  strictEqual(requestPaths.includes("/1.tar.gz"), true);
  strictEqual(requestPaths.includes("/1.tar"), true);
  strictEqual(requestPaths.includes("/2.tar.gz"), true);
  // primary succeeded for index 2; fallback must NOT be attempted
  strictEqual(
    requestPaths.includes("/2.tar"),
    false,
    `unexpected fallback request for /2.tar; log=${requestPaths.join(",")}`,
  );

  strictEqual(await readFile(join(distDir, "from-0.txt"), "utf8"), "from-0");
  strictEqual(await readFile(join(distDir, "from-1.txt"), "utf8"), "from-1");
  strictEqual(await readFile(join(distDir, "from-2.txt"), "utf8"), "from-2");
});

test("duplicate compression in chain fails before any HTTP request", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-migration-dup-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const cdn = await startMockCdn({ archives: new Map<string, Buffer>() });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "old-files",
      "--compression",
      "gz",
      "--decompression-fallback",
      "gz",
      "--keep",
      "5",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /appears more than once/);
  strictEqual(
    cdn.requestLog.length,
    0,
    `expected empty request log; got ${cdn.requestLog.length} entries`,
  );
});

test("write path uses primary suffix even when fetch resolves via fallback", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-primary-suffix-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0Tar = await makeTarFromTree(
    { "from-fallback.txt": "from-fallback" },
    { compression: "none" },
  );

  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", archive0Tar]]),
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
      "--decompression-fallback",
      "none",
      "--keep",
      "5",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  const requestPaths = cdn.requestLog.map((e) => e.path);
  strictEqual(
    requestPaths.includes("/0.tar.gz"),
    true,
    `expected primary 404 attempt for /0.tar.gz; log=${requestPaths.join(",")}`,
  );
  strictEqual(
    requestPaths.includes("/0.tar"),
    true,
    `expected fallback resolution at /0.tar; log=${requestPaths.join(",")}`,
  );

  strictEqual(
    existsSync(join(distDir, "old-files", "0.tar.gz")),
    true,
    `expected createArchive to write 0.tar.gz (primary suffix); stderr was:\n${result.stderr}`,
  );
  strictEqual(
    existsSync(join(distDir, "old-files", "0.tar")),
    false,
    `expected no 0.tar (fallback suffix is read-only); stderr was:\n${result.stderr}`,
  );

  strictEqual(
    existsSync(join(distDir, "old-files", "1.tar")),
    true,
    `expected fetch-saved 1.tar from fallback resolution; stderr was:\n${result.stderr}`,
  );
  strictEqual(await readFile(join(distDir, "from-fallback.txt"), "utf8"), "from-fallback");
});
