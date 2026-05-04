#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { list } from "tar";

const projectRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const declaredBin = pkg.bin?.["deploy-echoes"];
if (typeof declaredBin !== "string" || declaredBin.length === 0) {
  console.error("package.json bin.deploy-echoes is missing");
  process.exit(1);
}
const expectedTarballEntry = `package/${declaredBin}`;

const workDir = mkdtempSync(join(tmpdir(), "deploy-echoes-verify-pack-"));
let exitCode = 0;
try {
  const tarballPath = join(workDir, "package.tgz");
  const pack = spawnSync("pnpm", ["pack", "--out", tarballPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    console.error(pack.stderr);
    throw new Error(`pnpm pack failed with exit code ${pack.status}`);
  }
  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball not found at ${tarballPath}`);
  }

  const entries = [];
  // oxlint-disable-next-line @typescript-eslint/await-thenable -- tar.list returns a Promise when `file` is provided; the linter cannot see types in this .mjs file.
  await list({
    file: tarballPath,
    onentry: (entry) => {
      entries.push(entry.path);
    },
  });
  if (!entries.includes(expectedTarballEntry)) {
    throw new Error(
      `Packed tarball missing declared bin entry '${expectedTarballEntry}'. Tarball contents:\n${entries.join("\n")}`,
    );
  }
  console.log(`OK: tarball contains ${expectedTarballEntry}`);

  const consumerDir = join(workDir, "consumer");
  spawnSync("mkdir", ["-p", consumerDir]);
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "verify-pack-consumer", version: "0.0.0", private: true }) + "\n",
  );
  const install = spawnSync("pnpm", ["add", tarballPath], {
    cwd: consumerDir,
    encoding: "utf8",
  });
  if (install.status !== 0) {
    throw new Error(
      `pnpm add of packed tarball failed (exit ${install.status})\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
  }

  const installedBin = join(consumerDir, "node_modules", pkg.name, declaredBin);
  if (!existsSync(installedBin)) {
    throw new Error(`Installed package is missing ${declaredBin} at ${installedBin}`);
  }

  const help = spawnSync(process.execPath, [installedBin, "--help"], { encoding: "utf8" });
  if (help.status !== 0) {
    throw new Error(
      `Packed CLI --help exited with ${help.status}\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`,
    );
  }
  if (!help.stdout.includes("Usage: deploy-echoes")) {
    throw new Error(
      `Packed CLI --help output did not contain expected usage banner:\n${help.stdout}`,
    );
  }
  console.log("OK: installed packed CLI executes --help and prints usage banner");
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
