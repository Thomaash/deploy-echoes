import { strictEqual, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

test("archive-dir is wiped before each run; pre-existing dist files preserved", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-clean-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));

  const indexContent = "<html><body>local</body></html>";
  const appContent = "console.log('local');";
  await writeFile(join(distDir, "index.html"), indexContent);
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "assets", "app.js"), appContent);

  await mkdir(join(distDir, "old-files"));
  await writeFile(join(distDir, "old-files", "leftover.tar"), "stale archive");
  await writeFile(join(distDir, "old-files", "should-be-wiped.txt"), "stale junk");

  const indexHash = sha256(indexContent);
  const appHash = sha256(appContent);

  const archive0 = await makeTarFromTree(
    { "from-upstream-0.txt": "from-upstream-0" },
    { compression: "none" },
  );
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", archive0]]),
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
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  await rejects(() => stat(join(distDir, "old-files", "leftover.tar")), { code: "ENOENT" });
  await rejects(() => stat(join(distDir, "old-files", "should-be-wiped.txt")), { code: "ENOENT" });

  strictEqual(sha256(await readFile(join(distDir, "index.html"))), indexHash);
  strictEqual(sha256(await readFile(join(distDir, "assets", "app.js"))), appHash);
});

test("multi-orphan archive directory is fully cleaned before create and fetch", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-clean-multi-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));

  await writeFile(join(distDir, "index.html"), "<html><body>local</body></html>");

  await mkdir(join(distDir, "archives"), { recursive: true });
  for (let i = 0; i < 10; i++) {
    await writeFile(join(distDir, "archives", `${i}.tar.gz`), `orphan-${i}`);
  }

  const cdn = await startMockCdn({ archives: new Map() });
  t.after(() => cdn.close());

  const result = await runCli(
    [
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--compression",
      "none",
      "--keep",
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  for (let i = 0; i < 10; i++) {
    await rejects(() => stat(join(distDir, "archives", `${i}.tar.gz`)), { code: "ENOENT" });
  }

  await stat(join(distDir, "archives", "0.tar"));
});

test("local 0.tar wins over upstream copy for same path under --skip-old-files", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-clean-newer-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));

  const localIndex = "<html><body>LOCAL VERSION</body></html>";
  await writeFile(join(distDir, "index.html"), localIndex);

  const upstreamIndex = "<html><body>UPSTREAM VERSION</body></html>";
  const archive0 = await makeTarFromTree(
    { "index.html": upstreamIndex, "from-upstream-0.txt": "from-upstream-0" },
    { compression: "none" },
  );
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", archive0]]),
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
      "1",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);
  strictEqual(await readFile(join(distDir, "index.html"), "utf8"), localIndex);
  strictEqual(await readFile(join(distDir, "from-upstream-0.txt"), "utf8"), "from-upstream-0");
});
