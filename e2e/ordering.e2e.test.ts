import { strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "./helpers/cli-runner.ts";
import { startMockCdn } from "./helpers/mock-cdn.ts";
import { makeTarFromTree } from "./helpers/tar-helpers.ts";

test("numeric ordering: marker.txt resolves to upstream-2's content, not upstream-10's", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "deploy-echoes-e2e-ordering-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>local</html>");

  const archives = new Map<string, Buffer>();
  for (let i = 0; i <= 10; i++) {
    const tree: Record<string, string> = { [`from-${i}.txt`]: `from-${i}` };
    if (i === 2) tree["marker.txt"] = "from-archive-2";
    if (i === 10) tree["marker.txt"] = "from-archive-10";
    archives.set(`${i}.tar`, await makeTarFromTree(tree, { compression: "none" }));
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
      "11",
      cdn.url,
    ],
    { cwd: distDir },
  );

  strictEqual(result.code, 0, `expected exit 0; stderr was:\n${result.stderr}`);
  // Local naming places upstream 2 at 3.tar and upstream 10 at 11.tar. Under numeric
  // ordering 3 < 11 so 3.tar's marker wins; under alphabetic ordering "11.tar" < "3.tar"
  // and the test would (incorrectly) see "from-archive-10". This scenario exists to lock in
  // the numeric ordering — the failure mode is the latent shell-glob bug from the legacy script.
  strictEqual(await readFile(join(distDir, "marker.txt"), "utf8"), "from-archive-2");
});
