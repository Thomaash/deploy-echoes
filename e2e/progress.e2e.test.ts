import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

function countMatches(s: string, re: RegExp): number {
  const matches = s.match(re);
  return matches === null ? 0 : matches.length;
}

describe("progress output", () => {
  it("emits no 'no more archives on cdn' line when --keep is fully consumed", async (t) => {
    const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-progress-keep-"));
    t.after(() => rm(distDir, { recursive: true, force: true }));
    await writeFile(join(distDir, "index.html"), "<html>local</html>");

    const archives = new Map<string, Buffer>();
    for (let i = 0; i < 9; i++) {
      const body = await makeTarFromTree(
        { [`from-${i}.txt`]: `from-${i}` },
        { compression: "none" },
      );
      archives.set(`${i}.tar`, body);
    }

    const cdn = await startMockCdn({ archives });
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
    strictEqual(result.stdout, "", `stdout should be empty; got: ${JSON.stringify(result.stdout)}`);
    strictEqual(
      countMatches(result.stderr, /^created /gm),
      1,
      `expected exactly one 'created' line; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^fetched /gm),
      9,
      `expected exactly nine 'fetched' lines; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^extracted /gm),
      10,
      `expected exactly ten 'extracted' lines; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      result.stderr.includes("no more archives on cdn"),
      false,
      `should not emit the gap line when --keep is consumed; stderr was:\n${result.stderr}`,
    );
  });

  it("emits 'no more archives on cdn' once when upstream runs out before --keep", async (t) => {
    const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-progress-gap-"));
    t.after(() => rm(distDir, { recursive: true, force: true }));
    await writeFile(join(distDir, "index.html"), "<html>local</html>");

    const archives = new Map<string, Buffer>();
    for (let i = 0; i < 9; i++) {
      const body = await makeTarFromTree(
        { [`from-${i}.txt`]: `from-${i}` },
        { compression: "none" },
      );
      archives.set(`${i}.tar`, body);
    }

    const cdn = await startMockCdn({ archives });
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
        "20",
        cdn.url,
      ],
      { cwd: distDir },
    );

    strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);
    strictEqual(result.stdout, "", `stdout should be empty; got: ${JSON.stringify(result.stdout)}`);
    strictEqual(
      countMatches(result.stderr, /^created /gm),
      1,
      `expected exactly one 'created' line; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^fetched /gm),
      9,
      `expected exactly nine 'fetched' lines; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^no more archives on cdn$/gm),
      1,
      `expected exactly one gap line; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^extracted /gm),
      10,
      `expected exactly ten 'extracted' lines; stderr was:\n${result.stderr}`,
    );

    // The gap line MUST appear after the last fetched and before the first extracted.
    const lastFetched = result.stderr.lastIndexOf("fetched 9.tar");
    const gapIdx = result.stderr.indexOf("no more archives on cdn");
    const firstExtracted = result.stderr.indexOf("extracted ");
    strictEqual(
      lastFetched > -1 && gapIdx > lastFetched,
      true,
      `gap line should appear after 'fetched 9.tar'; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      firstExtracted > -1 && gapIdx < firstExtracted,
      true,
      `gap line should appear before the first 'extracted' line; stderr was:\n${result.stderr}`,
    );
  });

  it("emits 'no more archives on cdn' when the CDN is empty", async (t) => {
    const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-progress-empty-"));
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
    strictEqual(result.stdout, "", `stdout should be empty; got: ${JSON.stringify(result.stdout)}`);
    strictEqual(
      countMatches(result.stderr, /^created 0\.tar$/gm),
      1,
      `expected exactly one 'created 0.tar'; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^fetched /gm),
      0,
      `expected zero 'fetched' lines on empty CDN; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^no more archives on cdn$/gm),
      1,
      `expected exactly one gap line; stderr was:\n${result.stderr}`,
    );
    strictEqual(
      countMatches(result.stderr, /^extracted /gm),
      1,
      `expected exactly one 'extracted' line; stderr was:\n${result.stderr}`,
    );
  });
});
