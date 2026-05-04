import { match, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

test("happy path: contiguous --compression none archives at indexes 0,1,2", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");
  await writeFile(join(distDir, "app.js"), "// local");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "none" });
  const archive1 = await makeTarFromTree({ "from-1.txt": "from-1" }, { compression: "none" });
  const archive2 = await makeTarFromTree({ "from-2.txt": "from-2" }, { compression: "none" });

  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([
      ["0.tar", archive0],
      ["1.tar", archive1],
      ["2.tar", archive2],
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

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  const archives = (await readdir(join(distDir, "old-files"))).toSorted();
  strictEqual(archives.join(","), ["0.tar", "1.tar", "2.tar", "3.tar"].join(","));

  strictEqual(await readFile(join(distDir, "from-0.txt"), "utf8"), "from-0");
  strictEqual(await readFile(join(distDir, "from-1.txt"), "utf8"), "from-1");
  strictEqual(await readFile(join(distDir, "from-2.txt"), "utf8"), "from-2");
});

test("stop-on-gap: 404 at upstream index 2 halts further fetching", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "none" });
  const archive1 = await makeTarFromTree({ "from-1.txt": "from-1" }, { compression: "none" });

  const cdn = await startMockCdn({
    archives: new Map<string, Buffer>([
      ["0.tar", archive0],
      ["1.tar", archive1],
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

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  const archives = (await readdir(join(distDir, "old-files"))).toSorted();
  strictEqual(archives.join(","), ["0.tar", "1.tar", "2.tar"].join(","));

  const requestPaths = cdn.requestLog.map((entry) => entry.path);
  strictEqual(
    requestPaths.includes("/3.tar"),
    false,
    "should not request index 3 after stop-on-gap",
  );
});

test("--keep 9 with no archives at upstream: only local 0.tar remains", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-"));
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
      "none",
      "--keep",
      "9",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);

  const archives = (await readdir(join(distDir, "old-files"))).toSorted();
  strictEqual(archives.join(","), "0.tar");

  const tarRequests = cdn.requestLog.filter((e) => e.path === "/0.tar");
  strictEqual(
    tarRequests.length,
    1,
    `expected exactly one request to /0.tar; got ${cdn.requestLog.length} total`,
  );
});

test("--keep 1 fetches only upstream index 0", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archive0 = await makeTarFromTree({ "from-0.txt": "from-0" }, { compression: "none" });
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
  const requestPaths = cdn.requestLog.map((e) => e.path);
  strictEqual(requestPaths.includes("/0.tar"), true);
  strictEqual(requestPaths.includes("/1.tar"), false);
});

test("rejects http:// CDN URL: validation fails before any network request", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-https-only-"));
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
      "http://example.invalid/cdn",
    ],
    { cwd: distDir },
  );

  strictEqual(
    result.code !== 0,
    true,
    `expected non-zero exit; got ${result.code}; stderr was:\n${result.stderr}`,
  );
  match(result.stderr, /must use HTTPS/);
});
