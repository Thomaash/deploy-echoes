import { rejects, strictEqual } from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { promisify } from "node:util";

function assertString(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string") throw new TypeError(`expected ${label} to be string, got ${typeof v}`);
}

function assertNumber(v: unknown, label: string): asserts v is number {
  if (typeof v !== "number") throw new TypeError(`expected ${label} to be number, got ${typeof v}`);
}

const execFile = promisify(execFileCb);

const CLI_PATH = resolve(import.meta.dirname, "cli.ts");

// A CDN URL that will reliably fail fast on fetch without hitting the public
// internet. Using port 1 (reserved tcpmux) on localhost causes an immediate
// ECONNREFUSED, so the CLI exits non-zero after createArchive runs but before
// any real network traffic is generated.
const UNREACHABLE_CDN = "https://localhost:1/archives";

async function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  try {
    const result = await execFile(process.execPath, ["--no-warnings", CLI_PATH, ...args], {
      cwd: opts.cwd,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    if (!("stdout" in error && "stderr" in error && "code" in error)) throw error;
    assertString(error.stdout, "execFile error.stdout");
    assertString(error.stderr, "execFile error.stderr");
    assertNumber(error.code, "execFile error.code");
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

describe("cli --help", () => {
  it("documents --compression and --decompression-fallback", async () => {
    const { stdout, code } = await runCli(["--help"]);
    strictEqual(code, 0, "help should exit 0");
    strictEqual(
      stdout.includes("--compression"),
      true,
      `help should mention --compression; got: ${stdout}`,
    );
    strictEqual(
      stdout.includes("--decompression-fallback"),
      true,
      `help should mention --decompression-fallback; got: ${stdout}`,
    );
    // Help should note that the fallback flag is repeatable / ordered / 404-driven.
    strictEqual(
      /repeat|order|404/i.test(stdout),
      true,
      `help should describe the fallback semantics (repeatable, ordered, applied on 404); got: ${stdout}`,
    );
  });

  it("documents --request-timeout with unit, validation rule, default, and zero-disables note", async () => {
    const { stdout, code } = await runCli(["--help"]);
    strictEqual(code, 0, "help should exit 0");
    const line = stdout.split("\n").find((l: string) => l.includes("--request-timeout"));
    strictEqual(
      line !== undefined,
      true,
      `help should include a --request-timeout line; got: ${stdout}`,
    );
    const text = line ?? "";
    strictEqual(
      /seconds/i.test(text),
      true,
      `--request-timeout description should name seconds; got: ${text}`,
    );
    strictEqual(
      /non-negative integer/i.test(text),
      true,
      `--request-timeout description should state non-negative integer rule; got: ${text}`,
    );
    strictEqual(
      /default:\s*30/i.test(text),
      true,
      `--request-timeout description should state default 30; got: ${text}`,
    );
    strictEqual(
      /0 disables/i.test(text),
      true,
      `--request-timeout description should note that 0 disables; got: ${text}`,
    );
  });
});

describe("cli --request-timeout validation", () => {
  let tmpDir: string;
  let distDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cli-rt-test-"));
    distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts --request-timeout 0 and proceeds past validation", async () => {
    const { stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--request-timeout",
      "0",
    ]);
    // The run will exit non-zero (CDN unreachable), but it must do so AFTER
    // validation, not because the flag itself is rejected.
    strictEqual(
      stderr.includes("--request-timeout"),
      false,
      `--request-timeout 0 should be accepted; stderr: ${stderr}`,
    );

    const files = await readdir(join(distDir, "archives"));
    strictEqual(
      files.includes("0.tar.gz"),
      true,
      `validation should have passed and createArchive run; got: ${JSON.stringify(files)}`,
    );
  });

  it("rejects --request-timeout abc with stderr naming the flag", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--request-timeout",
      "abc",
    ]);
    strictEqual(code !== 0, true, "non-numeric --request-timeout should exit non-zero");
    strictEqual(
      stderr.includes("--request-timeout"),
      true,
      `error should name --request-timeout; got: ${stderr}`,
    );
  });

  it("rejects --request-timeout -1 with stderr naming the flag", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--request-timeout",
      "-1",
    ]);
    strictEqual(code !== 0, true, "negative --request-timeout should exit non-zero");
    strictEqual(
      stderr.includes("--request-timeout"),
      true,
      `error should name --request-timeout; got: ${stderr}`,
    );
  });
});

describe("cli compression flag end-to-end", () => {
  let tmpDir: string;
  let distDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cli-test-"));
    distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("with no flags, produces a 0.tar.gz archive (default behavior preserved)", async () => {
    // CLI will fail at fetch (unreachable CDN), but createArchive runs first.
    await runCli([UNREACHABLE_CDN, "--dist", distDir, "--archive-dir", "archives", "--keep", "1"]);

    const files = await readdir(join(distDir, "archives"));
    strictEqual(
      files.includes("0.tar.gz"),
      true,
      `default compression should produce 0.tar.gz; got: ${JSON.stringify(files)}`,
    );
  });

  it("with --compression none, produces a 0.tar archive", async () => {
    await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "none",
    ]);

    const files = await readdir(join(distDir, "archives"));
    strictEqual(
      files.includes("0.tar"),
      true,
      `--compression none should produce 0.tar; got: ${JSON.stringify(files)}`,
    );
  });

  it("accepts --decompression-fallback as a repeatable flag", async () => {
    // A duplicate-free chain should not error during arg parsing/validation.
    // The CLI will still exit non-zero because the CDN is unreachable, but the
    // *cause* must be the network failure, not arg parsing or duplicate detection.
    const { stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "none",
      "--decompression-fallback",
      "gz",
    ]);

    // Must not error on duplicate / unknown flag — those are different failure modes.
    strictEqual(
      /unknown option|duplicate/i.test(stderr),
      false,
      `repeatable --decompression-fallback should be accepted; stderr: ${stderr}`,
    );

    // The primary suffix should still drive create.
    const files = await readdir(join(distDir, "archives"));
    strictEqual(
      files.includes("0.tar"),
      true,
      `with --compression none, expected 0.tar; got: ${JSON.stringify(files)}`,
    );
  });

  it("rejects a chain in which the primary appears as a fallback", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "gz",
      "--decompression-fallback",
      "gz",
    ]);

    strictEqual(code !== 0, true, "duplicate chain should exit non-zero");
    strictEqual(stderr.includes("gz"), true, `error should name the duplicate; got: ${stderr}`);
  });

  it("rejects --compression zst with a message naming the value and the supported set", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "zst",
    ]);
    strictEqual(code !== 0, true, "unsupported --compression should exit non-zero");
    strictEqual(stderr.includes("'zst'"), true, `error should name the value; got: ${stderr}`);
    strictEqual(stderr.includes("gz"), true, `error should list 'gz'; got: ${stderr}`);
    strictEqual(stderr.includes("none"), true, `error should list 'none'; got: ${stderr}`);
  });

  it("rejects --compression xz with a message naming the value and the supported set", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "xz",
    ]);
    strictEqual(code !== 0, true, "unsupported --compression should exit non-zero");
    strictEqual(stderr.includes("'xz'"), true, `error should name the value; got: ${stderr}`);
    strictEqual(stderr.includes("gz"), true, `error should list 'gz'; got: ${stderr}`);
    strictEqual(stderr.includes("none"), true, `error should list 'none'; got: ${stderr}`);
  });

  it("rejects --compression lz4 with a message naming the value and the supported set", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "lz4",
    ]);
    strictEqual(code !== 0, true, "unsupported --compression should exit non-zero");
    strictEqual(stderr.includes("'lz4'"), true, `error should name the value; got: ${stderr}`);
    strictEqual(stderr.includes("gz"), true, `error should list 'gz'; got: ${stderr}`);
    strictEqual(stderr.includes("none"), true, `error should list 'none'; got: ${stderr}`);
  });

  it("rejects --compression bz2 with a message naming the value and the supported set", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "bz2",
    ]);
    strictEqual(code !== 0, true, "unsupported --compression should exit non-zero");
    strictEqual(stderr.includes("'bz2'"), true, `error should name the value; got: ${stderr}`);
    strictEqual(stderr.includes("gz"), true, `error should list 'gz'; got: ${stderr}`);
    strictEqual(stderr.includes("none"), true, `error should list 'none'; got: ${stderr}`);
  });

  it("rejects --decompression-fallback xz with a message naming the value and the supported set", async () => {
    const { code, stderr } = await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--decompression-fallback",
      "xz",
    ]);
    strictEqual(code !== 0, true, "unsupported --decompression-fallback should exit non-zero");
    strictEqual(stderr.includes("'xz'"), true, `error should name the value; got: ${stderr}`);
    strictEqual(stderr.includes("gz"), true, `error should list 'gz'; got: ${stderr}`);
    strictEqual(stderr.includes("none"), true, `error should list 'none'; got: ${stderr}`);
  });

  it("deletes orphan archives from previous runs before building (regression for stale-suffix precedence)", async () => {
    const orphanDir = join(tmpDir, "orphan-src");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "orphan-marker.txt"), "from-orphan-run");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });
    await execFile("tar", ["-czf", join(archiveSubDir, "0.tar.gz"), "-C", orphanDir, "."]);

    await runCli([
      UNREACHABLE_CDN,
      "--dist",
      distDir,
      "--archive-dir",
      "archives",
      "--keep",
      "1",
      "--compression",
      "none",
    ]);

    const files = await readdir(archiveSubDir);
    strictEqual(
      files.includes("0.tar.gz"),
      false,
      `orphan 0.tar.gz should have been deleted; got: ${JSON.stringify(files)}`,
    );
    strictEqual(
      files.includes("0.tar"),
      true,
      `fresh 0.tar should exist; got: ${JSON.stringify(files)}`,
    );

    await rejects(() => stat(join(distDir, "orphan-marker.txt")), { code: "ENOENT" });
  });
});
