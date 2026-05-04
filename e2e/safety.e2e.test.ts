import { strictEqual, match, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeUnsafeTar } from "./helpers/tar-helpers.ts";

async function setupDist(t: { after: (fn: () => unknown) => void }): Promise<{
  parent: string;
  distDir: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-safety-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const distDir = join(parent, "dist");
  await mkdir(distDir);
  await writeFile(join(distDir, "index.html"), "<html>local</html>");
  return { parent, distDir };
}

test("rejects archive entry with .. traversal segment", async (t) => {
  const { parent, distDir } = await setupDist(t);

  const evil = await makeUnsafeTar([{ name: "../escape.txt", type: "file", content: "pwned" }]);
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", evil]]),
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

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /Unsafe entries in archive:/);
  await rejects(() => stat(join(parent, "escape.txt")), { code: "ENOENT" });
});

test("accepts absolute-path entry and extracts it under distDir", async (t) => {
  const { distDir } = await setupDist(t);

  const evil = await makeUnsafeTar([
    { name: "/tmp/deploy-echoes-e2e-absolute-victim.txt", type: "file", content: "pwned" },
  ]);
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", evil]]),
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

  strictEqual(result.code, 0, `expected zero exit; got ${result.code} (stderr: ${result.stderr})`);
  await rejects(() => stat("/tmp/deploy-echoes-e2e-absolute-victim.txt"), { code: "ENOENT" });
  const landed = await stat(join(distDir, "tmp", "deploy-echoes-e2e-absolute-victim.txt"));
  strictEqual(landed.isFile(), true);
});

test("rejects archive entry with symlink type", async (t) => {
  const { distDir } = await setupDist(t);

  const evil = await makeUnsafeTar([
    { name: "evil-link", type: "symlink", linkTarget: "/etc/passwd" },
  ]);
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", evil]]),
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

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /Unsafe entries in archive:/);
  await rejects(() => stat(join(distDir, "evil-link")), { code: "ENOENT" });
});

test("rejects archive entry with hardlink type", async (t) => {
  const { distDir } = await setupDist(t);

  const evil = await makeUnsafeTar([
    { name: "evil-hard", type: "hardlink", linkTarget: "real.txt" },
  ]);
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", evil]]),
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

  strictEqual(result.code !== 0, true, `expected non-zero exit; got ${result.code}`);
  match(result.stderr, /Unsafe entries in archive:/);
});

test("extracted files are owned by the current user, not by the uid/gid recorded in the archive", async (t) => {
  const { distDir } = await setupDist(t);

  const runnerUid = process.getuid?.();
  const runnerGid = process.getgid?.();
  if (runnerUid === undefined || runnerGid === undefined) {
    t.skip("requires POSIX getuid/getgid");
    return;
  }

  const ARCHIVE_UID = 65534;
  const ARCHIVE_GID = 65534;
  if (runnerUid === ARCHIVE_UID && runnerGid === ARCHIVE_GID) {
    t.skip("test runner is uid/gid 65534; cannot distinguish runner from archive value");
    return;
  }

  const archive = await makeUnsafeTar([
    { name: "owned.txt", type: "file", content: "hello", uid: ARCHIVE_UID, gid: ARCHIVE_GID },
  ]);
  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([["0.tar", archive]]),
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

  strictEqual(result.code, 0, `expected zero exit; got ${result.code} (stderr: ${result.stderr})`);

  const extracted = await stat(join(distDir, "owned.txt"));
  strictEqual(
    extracted.uid,
    runnerUid,
    `extracted uid ${extracted.uid} should equal runner uid ${runnerUid}`,
  );
  strictEqual(
    extracted.gid,
    runnerGid,
    `extracted gid ${extracted.gid} should equal runner gid ${runnerGid}`,
  );
  strictEqual(
    extracted.uid !== ARCHIVE_UID,
    true,
    `extracted uid must differ from archive's recorded uid ${ARCHIVE_UID}`,
  );
  strictEqual(
    extracted.gid !== ARCHIVE_GID,
    true,
    `extracted gid must differ from archive's recorded gid ${ARCHIVE_GID}`,
  );
});
