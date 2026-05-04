import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readFile,
  readdir,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { promisify } from "node:util";

import { list } from "tar";

import {
  cleanArchiveDir,
  createArchive,
  extractArchives,
  validateArchiveContents,
} from "./archive.ts";

const execFile = promisify(execFileCb);

describe("validateArchiveContents", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "archive-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a clean archive with relative paths", async () => {
    const contentDir = join(tmpDir, "content");
    const assetsDir = join(contentDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(contentDir, "index.html"), "<html></html>");
    await writeFile(join(assetsDir, "style.css"), "body {}");

    const archivePath = join(tmpDir, "clean.tar.gz");
    await execFile("tar", ["-czf", archivePath, "-C", contentDir, "."]);

    await validateArchiveContents(archivePath);
  });

  it("rejects archive with .. path traversal with type=File and the offending path", async () => {
    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "file.txt"), "test");

    const archivePath = join(tmpDir, "traversal.tar.gz");
    await execFile("tar", [
      "-czf",
      archivePath,
      "--transform",
      "s|file.txt|../../etc/passwd|",
      "-C",
      contentDir,
      "file.txt",
    ]);

    await rejects(
      () => validateArchiveContents(archivePath),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw new TypeError("expected Error instance", { cause: error });
        }
        strictEqual(
          error.message.startsWith("Unsafe entries in archive:"),
          true,
          `expected message to begin with 'Unsafe entries in archive:'; got: ${error.message}`,
        );
        const body = error.message.slice("Unsafe entries in archive:\n".length);
        strictEqual(
          body.includes("type=File"),
          true,
          `expected body to mention type=File; got: ${body}`,
        );
        strictEqual(
          body.includes("../../etc/passwd"),
          true,
          `expected body to include the offending path; got: ${body}`,
        );
        return true;
      },
    );
  });

  it("rejects archive containing a symlink entry with type=SymbolicLink and linkpath", async () => {
    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "index.html"), "<html></html>");
    await symlink("/etc/passwd", join(contentDir, "evil-link"));

    const archivePath = join(tmpDir, "with-symlink.tar");
    await execFile("tar", ["-cf", archivePath, "-C", contentDir, "."]);

    await rejects(
      () => validateArchiveContents(archivePath),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw new TypeError("expected Error instance", { cause: error });
        }
        strictEqual(
          error.message.startsWith("Unsafe entries in archive:"),
          true,
          `expected message to begin with 'Unsafe entries in archive:'; got: ${error.message}`,
        );
        const body = error.message.slice("Unsafe entries in archive:\n".length);
        strictEqual(
          body.includes("type=SymbolicLink"),
          true,
          `expected body to mention type=SymbolicLink; got: ${body}`,
        );
        strictEqual(
          body.includes("linkpath=/etc/passwd"),
          true,
          `expected body to surface linkpath; got: ${body}`,
        );
        return true;
      },
    );
  });

  it("rejects archive containing a hardlink entry with type=Link surfaced", async () => {
    // Build a real hardlink in the filesystem, then archive both files; tar
    // records the second of two hardlinks as a Link entry referencing the first.
    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "real.txt"), "hi");
    await link(join(contentDir, "real.txt"), join(contentDir, "evil-hard"));

    const archivePath = join(tmpDir, "with-hardlink.tar");
    await execFile("tar", ["-cf", archivePath, "-C", contentDir, "real.txt", "evil-hard"]);

    await rejects(
      () => validateArchiveContents(archivePath),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw new TypeError("expected Error instance", { cause: error });
        }
        strictEqual(
          error.message.startsWith("Unsafe entries in archive:"),
          true,
          `expected message to begin with 'Unsafe entries in archive:'; got: ${error.message}`,
        );
        const body = error.message.slice("Unsafe entries in archive:\n".length);
        strictEqual(
          body.includes("type=Link"),
          true,
          `expected body to mention type=Link; got: ${body}`,
        );
        strictEqual(
          body.includes("linkpath=real.txt"),
          true,
          `expected body to surface linkpath; got: ${body}`,
        );
        return true;
      },
    );
  });

  it("accepts an absolute-path regular file at the validator (containment is at extraction)", async () => {
    // Use tar -P to preserve the absolute path in the stored entry. The
    // validator must accept this; containment under distDir is enforced by
    // node-tar at extraction time.
    const absDir = await mkdtemp(join(tmpdir(), "abs-content-"));
    try {
      const absFile = join(absDir, "file.txt");
      await writeFile(absFile, "abs contents");

      const archivePath = join(tmpDir, "absolute-only.tar");
      await execFile("tar", ["-cPf", archivePath, absFile]);

      await validateArchiveContents(archivePath);
    } finally {
      await rm(absDir, { recursive: true, force: true });
    }
  });

  it("reports every offending entry in one error", async () => {
    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "file.txt"), "test");
    await symlink("/etc/passwd", join(contentDir, "evil-link"));

    const archivePath = join(tmpDir, "multi-offender.tar.gz");
    await execFile("tar", [
      "-czf",
      archivePath,
      "--transform",
      "s|file.txt|../../etc/passwd|",
      "-C",
      contentDir,
      "evil-link",
      "file.txt",
    ]);

    await rejects(
      () => validateArchiveContents(archivePath),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw new TypeError("expected Error instance", { cause: error });
        }
        strictEqual(
          error.message.startsWith("Unsafe entries in archive:"),
          true,
          `expected message to begin with 'Unsafe entries in archive:'; got: ${error.message}`,
        );
        const body = error.message.slice("Unsafe entries in archive:\n".length);
        const lines = body.split("\n").filter((l) => l !== "");
        const hasSymlinkLine = lines.some((line) => line.includes("type=SymbolicLink"));
        const hasTraversalLine = lines.some(
          (line) => line.includes("type=File") && line.includes(".."),
        );
        strictEqual(
          hasSymlinkLine,
          true,
          `expected a line with type=SymbolicLink in body; got: ${body}`,
        );
        strictEqual(
          hasTraversalLine,
          true,
          `expected a line with type=File and '..' in body; got: ${body}`,
        );
        strictEqual(
          lines.length >= 2,
          true,
          `expected at least 2 offender lines; got: ${JSON.stringify(lines)}`,
        );
        return true;
      },
    );
  });
});

describe("validateArchiveContents does not spawn tar", () => {
  let sandbox: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "validate-no-spawn-"));
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("does not invoke `tar -tvf` to list contents", async () => {
    // Build a real archive with the system tar before poisoning PATH.
    const contentDir = join(sandbox, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "hello.txt"), "hello world");
    const archivePath = join(sandbox, "clean.tar");
    await execFile("/usr/bin/tar", ["-cf", archivePath, "-C", contentDir, "."]);

    const fakeBinDir = join(sandbox, "fake-bin");
    const argsFile = join(sandbox, "tar-args.txt");
    await installFakeTar(fakeBinDir, argsFile, "/usr/bin/tar");
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

    await validateArchiveContents(archivePath);

    const log = await readFile(argsFile, "utf-8").catch(() => "");
    const calls = parseTarLog(log);
    const listCalls = calls.filter((c) => c.args.includes("-tvf"));
    strictEqual(
      listCalls.length,
      0,
      `expected no -tvf tar invocations; got ${JSON.stringify(listCalls)}`,
    );
  });
});

describe("cleanArchiveDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clean-archive-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes a pre-seeded archive directory", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });
    await writeFile(join(archiveSubDir, "stale.txt"), "stale");

    await cleanArchiveDir({ distDir, archiveDir: "archives" });

    await rejects(() => stat(archiveSubDir), { code: "ENOENT" });
  });

  it("is a no-op when the directory does not exist", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });

    await cleanArchiveDir({ distDir, archiveDir: "archives" });
  });
});

describe("createArchive", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "create-archive-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("produces an archive containing all dist files", async () => {
    const distDir = join(tmpDir, "dist");
    const assetsDir = join(distDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");
    await writeFile(join(assetsDir, "style.css"), "body {}");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const archivePath = join(distDir, "archives", "0.tar.gz");
    const { stdout } = await execFile("tar", ["-tf", archivePath]);
    const entries = stdout.split("\n").filter((l: string) => l !== "");

    const hasIndex = entries.some((e: string) => e.includes("index.html"));
    const hasStyle = entries.some((e: string) => e.includes("assets/style.css"));
    strictEqual(hasIndex, true, "archive should contain index.html");
    strictEqual(hasStyle, true, "archive should contain assets/style.css");
  });

  it("emits 'created <name>' to stderr after writing the archive", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    const errMock = mock.method(console, "error", () => {});

    await createArchive({ distDir, archiveDir: "deploy-echoes", compression: "gz" });

    const messages = errMock.mock.calls.map((c) => c.arguments[0]);
    const matches = messages.filter((m) => m === "created 0.tar.gz");
    strictEqual(
      matches.length,
      1,
      `expected exactly one 'created 0.tar.gz' on stderr; got: ${JSON.stringify(messages)}`,
    );
  });

  it("excludes the archive directory from the archive", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    // Pre-create archive dir with an existing file
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });
    await writeFile(join(archiveSubDir, "old.tar.gz"), "old data");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const archivePath = join(distDir, "archives", "0.tar.gz");
    const { stdout } = await execFile("tar", ["-tf", archivePath]);
    const entries = stdout.split("\n").filter((l: string) => l !== "");

    const hasArchiveDir = entries.some((e: string) => e.includes("archives"));
    strictEqual(hasArchiveDir, false, "archive should not contain the archive directory");
  });

  it("excludes only the configured archive directory and preserves similarly named siblings", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(join(distDir, "archives"), { recursive: true });
    await mkdir(join(distDir, "archives-keep"), { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");
    await writeFile(join(distDir, "archives", "stale.txt"), "stale");
    await writeFile(join(distDir, "archives-keep", "keep.txt"), "keep me");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const entries: string[] = [];
    await list({
      file: join(distDir, "archives", "0.tar.gz"),
      onentry: (entry) => {
        entries.push(entry.path.replace(/^\.\//, "").replace(/\/$/, ""));
      },
    });

    strictEqual(
      entries.includes("archives"),
      false,
      `archive should exclude 'archives'; got ${JSON.stringify(entries)}`,
    );
    strictEqual(
      entries.some((entry) => entry.startsWith("archives/")),
      false,
      `archive should exclude descendants of 'archives'; got ${JSON.stringify(entries)}`,
    );
    strictEqual(
      entries.includes("archives-keep/keep.txt"),
      true,
      `archive should preserve similarly named siblings; got ${JSON.stringify(entries)}`,
    );
  });
});

describe("extractArchives", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extract-archive-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts a single archive with correct contents", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // Create content and archive it
    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "hello.txt"), "hello world");

    await execFile("tar", ["-czf", join(archiveSubDir, "1.tar.gz"), "-C", contentDir, "."]);

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const content = await readFile(join(distDir, "hello.txt"), "utf-8");
    strictEqual(content, "hello world");
  });

  it("extracts in numeric order so newer (lower-numbered) archives win", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // Create 10.tar.gz with "old content"
    const oldDir = join(tmpDir, "old");
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "conflict.txt"), "old content");
    await execFile("tar", ["-czf", join(archiveSubDir, "10.tar.gz"), "-C", oldDir, "."]);

    // Create 2.tar.gz with "new content"
    const newDir = join(tmpDir, "new");
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "conflict.txt"), "new content");
    await execFile("tar", ["-czf", join(archiveSubDir, "2.tar.gz"), "-C", newDir, "."]);

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const content = await readFile(join(distDir, "conflict.txt"), "utf-8");
    strictEqual(content, "new content");
  });

  it("ignores non-.tar.gz files", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // Create non-tar.gz files
    await writeFile(join(archiveSubDir, "notes.txt"), "not an archive");
    await writeFile(join(archiveSubDir, "backup.tar.bak"), "not an archive");

    // Should complete without error
    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    // Verify no files were extracted
    const files = await readdir(distDir);
    const nonArchiveFiles = files.filter((f: string) => f !== "archives");
    strictEqual(nonArchiveFiles.length, 0);
  });

  it("ignores files without a leading numeric archive index", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "should-not-extract.txt"), "nope");
    await execFile("tar", ["-czf", join(archiveSubDir, "latest.tar.gz"), "-C", contentDir, "."]);

    const errMock = mock.method(console, "error", () => {});

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    await rejects(() => stat(join(distDir, "should-not-extract.txt")), { code: "ENOENT" });
    deepStrictEqual(
      errMock.mock.calls.map((call) => call.arguments[0]),
      [],
      "non-numeric archive names should be ignored before extraction logging",
    );
  });

  it("emits 'extracted <name> (+<count>)' per archive to stderr", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // 1.tar.gz: three files. Built with explicit filenames (no -C dir .) so
    // the archive contains no leading "./" directory entry — keeps the +N
    // count equal to file count.
    const firstSrc = join(tmpDir, "src-first");
    await mkdir(firstSrc, { recursive: true });
    await writeFile(join(firstSrc, "a.txt"), "alpha-1");
    await writeFile(join(firstSrc, "b.txt"), "bravo-1");
    await writeFile(join(firstSrc, "c.txt"), "charlie-1");
    await execFile("tar", [
      "-czf",
      join(archiveSubDir, "1.tar.gz"),
      "-C",
      firstSrc,
      "a.txt",
      "b.txt",
      "c.txt",
    ]);

    // 2.tar.gz: a.txt (collides) and d.txt (new). Both entries are listed
    // by tar -v on stdout regardless of --skip-old-files, so +N is 2.
    const secondSrc = join(tmpDir, "src-second");
    await mkdir(secondSrc, { recursive: true });
    await writeFile(join(secondSrc, "a.txt"), "alpha-2");
    await writeFile(join(secondSrc, "d.txt"), "delta-2");
    await execFile("tar", [
      "-czf",
      join(archiveSubDir, "2.tar.gz"),
      "-C",
      secondSrc,
      "a.txt",
      "d.txt",
    ]);

    const errMock = mock.method(console, "error", () => {});

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const messages = errMock.mock.calls.map((c) => c.arguments[0]);
    const extracted = messages.filter(
      (m: unknown) => typeof m === "string" && m.startsWith("extracted "),
    );
    strictEqual(
      extracted[0],
      "extracted 1.tar.gz (+3)",
      `first extracted line wrong; got: ${JSON.stringify(extracted)}`,
    );
    strictEqual(
      extracted[1],
      "extracted 2.tar.gz (+2)",
      `second extracted line wrong; got: ${JSON.stringify(extracted)}`,
    );
    strictEqual(
      extracted.length,
      2,
      `expected exactly two extracted lines; got: ${JSON.stringify(extracted)}`,
    );
  });

  it("completes without error on empty archive directory", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });
  });

  it("strips a leading slash from absolute-path entries and extracts under distDir", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    const contentDir = join(tmpDir, "content");
    await mkdir(contentDir, { recursive: true });
    const fileContents = "absolute-path entry contents";
    await writeFile(join(contentDir, "file.txt"), fileContents);

    await execFile("tar", [
      "-czf",
      join(archiveSubDir, "0.tar.gz"),
      "--transform",
      "s|file.txt|/etc/passwd|",
      "-C",
      contentDir,
      "file.txt",
    ]);

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const extracted = await readFile(join(distDir, "etc", "passwd"), "utf-8");
    strictEqual(extracted, fileContents);
  });
});

describe("createArchive with configurable compression", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "create-archive-suffix-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes 0.tar.gz when compression is gz", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const files = await readdir(join(distDir, "archives"));
    strictEqual(files.includes("0.tar.gz"), true, "expected 0.tar.gz to exist");
  });

  it("writes 0.tar when compression is none", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    await createArchive({ distDir, archiveDir: "archives", compression: "none" });

    const files = await readdir(join(distDir, "archives"));
    strictEqual(files.includes("0.tar"), true, "expected 0.tar to exist");
  });

  it("succeeds when compression=none and archive has ustar magic at offset 257", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    await createArchive({ distDir, archiveDir: "archives", compression: "none" });

    // Verify the ustar magic is actually there (sanity check on the symmetric pass).
    const buf = await readFile(join(distDir, "archives", "0.tar"));
    const magic = buf.subarray(257, 262).toString("ascii");
    strictEqual(magic, "ustar", "uncompressed tar should have ustar magic at offset 257");
  });

  it("succeeds when compression=gz and archive does not have ustar magic at offset 257", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const buf = await readFile(join(distDir, "archives", "0.tar.gz"));
    const magic = buf.subarray(257, 262).toString("ascii");
    strictEqual(
      magic === "ustar",
      false,
      "gzipped archive should not have ustar magic at offset 257",
    );
  });
});

describe("extractArchives with mixed suffixes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extract-mixed-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts archives with mixed suffixes from the configured chain in numeric order", async () => {
    const distDir = join(tmpDir, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // 0.tar.gz — newest
    const gzDir = join(tmpDir, "src-gz");
    await mkdir(gzDir, { recursive: true });
    await writeFile(join(gzDir, "marker.txt"), "from-gz");
    await writeFile(join(gzDir, "only-gz.txt"), "gz-only");
    await execFile("tar", ["-czf", join(archiveSubDir, "0.tar.gz"), "-C", gzDir, "."]);

    // 1.tar — oldest, uncompressed
    const tarDir = join(tmpDir, "src-tar");
    await mkdir(tarDir, { recursive: true });
    await writeFile(join(tarDir, "marker.txt"), "from-tar");
    await writeFile(join(tarDir, "only-tar.txt"), "tar-only");
    await execFile("tar", ["-cf", join(archiveSubDir, "1.tar"), "-C", tarDir, "."]);

    // Unrelated files in the same dir that must be ignored.
    await writeFile(join(archiveSubDir, "notes.txt"), "ignore me");
    await writeFile(join(archiveSubDir, "weird.tar.zst"), "ignore me too");

    await extractArchives({
      distDir,
      archiveDir: "archives",
      suffixes: [".tar.gz", ".tar"],
    });

    // Newer (lower-numbered) archives win for conflicting paths.
    const marker = await readFile(join(distDir, "marker.txt"), "utf-8");
    strictEqual(marker, "from-gz", "0.tar.gz should win conflicts");

    // Non-conflicting files from older archives should still be present.
    const onlyGz = await readFile(join(distDir, "only-gz.txt"), "utf-8");
    strictEqual(onlyGz, "gz-only");
    const onlyTar = await readFile(join(distDir, "only-tar.txt"), "utf-8");
    strictEqual(onlyTar, "tar-only");
  });
});

describe("createArchive + extractArchives round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "roundtrip-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracted files match originals", async () => {
    // Set up dist with files
    const distDir = join(tmpDir, "dist");
    const assetsDir = join(distDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html>hello</html>");
    await writeFile(join(assetsDir, "style.css"), "body { color: red; }");

    // Create archive
    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    // Set up a fresh dist to extract into
    const extractDir = join(tmpDir, "extract");
    const extractArchiveDir = join(extractDir, "archives");
    await mkdir(extractArchiveDir, { recursive: true });

    // Copy the archive to the extract directory
    const archiveData = await readFile(join(distDir, "archives", "0.tar.gz"));
    await writeFile(join(extractArchiveDir, "0.tar.gz"), archiveData);

    await extractArchives({ distDir: extractDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const indexContent = await readFile(join(extractDir, "index.html"), "utf-8");
    const styleContent = await readFile(join(extractDir, "assets", "style.css"), "utf-8");

    strictEqual(indexContent, "<html>hello</html>");
    strictEqual(styleContent, "body { color: red; }");
  });

  it("produced .tar.gz is a valid byte-stream readable by node-tar (gz)", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");
    await mkdir(join(distDir, "assets"), { recursive: true });
    await writeFile(join(distDir, "assets", "style.css"), "body {}");

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const archivePath = join(distDir, "archives", "0.tar.gz");
    const entries: string[] = [];
    await list({
      file: archivePath,
      onentry: (entry) => {
        entries.push(entry.path);
      },
    });
    strictEqual(
      entries.some((p) => p.endsWith("index.html")),
      true,
      `expected index.html in entries; got: ${JSON.stringify(entries)}`,
    );
    strictEqual(
      entries.some((p) => p.endsWith("assets/style.css")),
      true,
      `expected assets/style.css in entries; got: ${JSON.stringify(entries)}`,
    );
  });

  it("produced .tar is a valid byte-stream readable by node-tar (none)", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    await createArchive({ distDir, archiveDir: "archives", compression: "none" });

    const archivePath = join(distDir, "archives", "0.tar");
    const entries: string[] = [];
    await list({
      file: archivePath,
      onentry: (entry) => {
        entries.push(entry.path);
      },
    });
    strictEqual(
      entries.some((p) => p.endsWith("index.html")),
      true,
      `expected index.html in entries; got: ${JSON.stringify(entries)}`,
    );
  });

  it("round-trips with a leading-dash archiveDir like '-foo'", async () => {
    const distDir = join(tmpDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "alpha.txt"), "alpha contents");
    await writeFile(join(distDir, "beta.txt"), "beta contents");

    await cleanArchiveDir({ distDir, archiveDir: "-foo" });
    await createArchive({ distDir, archiveDir: "-foo", compression: "gz" });

    // Extract into a fresh dist to verify round-trip fidelity.
    const extractDir = join(tmpDir, "extract");
    const extractArchiveDir = join(extractDir, "-foo");
    await mkdir(extractArchiveDir, { recursive: true });
    const archiveData = await readFile(join(distDir, "-foo", "0.tar.gz"));
    await writeFile(join(extractArchiveDir, "0.tar.gz"), archiveData);

    await extractArchives({ distDir: extractDir, archiveDir: "-foo", suffixes: [".tar.gz"] });

    const alpha = await readFile(join(extractDir, "alpha.txt"), "utf-8");
    const beta = await readFile(join(extractDir, "beta.txt"), "utf-8");
    strictEqual(alpha, "alpha contents");
    strictEqual(beta, "beta contents");
  });
});

async function installFakeTar(
  fakeBinDir: string,
  argsFile: string,
  realTarPath: string,
): Promise<void> {
  await mkdir(fakeBinDir, { recursive: true });
  const script = `#!/bin/sh
{
  echo "PWD=$(pwd)"
  for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
  echo "==END=="
} >> "${argsFile}"
exec ${realTarPath} "$@"
`;
  await writeFile(join(fakeBinDir, "tar"), script);
  await chmod(join(fakeBinDir, "tar"), 0o755);
}

function parseTarLog(content: string): Array<{ pwd: string; args: string[] }> {
  const records: Array<{ pwd: string; args: string[] }> = [];
  const blocks = content.split("==END==");
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l !== "");
    if (lines.length === 0) continue;
    const pwdLine = lines.find((l: string) => l.startsWith("PWD="));
    if (pwdLine === undefined) continue;
    const pwd = pwdLine.slice("PWD=".length);
    const args = lines
      .filter((l: string) => l.startsWith("ARG="))
      .map((l: string) => l.slice("ARG=".length));
    records.push({ pwd, args });
  }
  return records;
}

describe("createArchive does not spawn tar", () => {
  let sandbox: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "create-no-spawn-"));
    originalPath = process.env.PATH;
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    process.env.PATH = originalPath;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("creates the archive without invoking the system tar binary", async () => {
    const distDir = join(sandbox, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html></html>");

    const fakeBinDir = join(sandbox, "fake-bin");
    const argsFile = join(sandbox, "tar-args.txt");
    await installFakeTar(fakeBinDir, argsFile, "/usr/bin/tar");
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

    await createArchive({ distDir, archiveDir: "archives", compression: "gz" });

    const log = await readFile(argsFile, "utf-8").catch(() => "");
    const calls = parseTarLog(log);
    strictEqual(
      calls.length,
      0,
      `expected no tar invocations during createArchive; got ${JSON.stringify(calls)}`,
    );
  });
});

describe("extractArchives does not spawn tar for extraction", () => {
  let sandbox: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "extract-no-spawn-"));
    originalCwd = process.cwd();
    originalPath = process.env.PATH;
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    process.env.PATH = originalPath;
    process.chdir(originalCwd);
    await rm(sandbox, { recursive: true, force: true });
  });

  it("extracts without invoking `tar -xvf`", async () => {
    process.chdir(sandbox);
    const distDir = join(sandbox, "dist");
    const archiveSubDir = join(distDir, "archives");
    await mkdir(archiveSubDir, { recursive: true });

    // Pre-seed an archive to extract using the system tar binary directly.
    const contentDir = join(sandbox, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "hello.txt"), "hello world");
    await execFile("/usr/bin/tar", [
      "-czf",
      join(archiveSubDir, "0.tar.gz"),
      "-C",
      contentDir,
      ".",
    ]);

    // Now poison PATH with a recording fake tar; if extractArchives spawns
    // tar to extract, it'll log a `-xvf` call here.
    const fakeBinDir = join(sandbox, "fake-bin");
    const argsFile = join(sandbox, "tar-args.txt");
    await installFakeTar(fakeBinDir, argsFile, "/usr/bin/tar");
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

    await extractArchives({ distDir, archiveDir: "archives", suffixes: [".tar.gz"] });

    const log = await readFile(argsFile, "utf-8").catch(() => "");
    const calls = parseTarLog(log);
    const extractCalls = calls.filter((c) => c.args.includes("-xvf"));
    strictEqual(
      extractCalls.length,
      0,
      `expected no -xvf tar invocations; got ${JSON.stringify(extractCalls)}`,
    );
  });
});
