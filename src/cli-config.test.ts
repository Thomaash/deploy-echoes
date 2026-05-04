import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parseCliConfig, type RawCliParseArgs } from "./cli-config.ts";

type RawCliOverrides = {
  positionals?: unknown[];
  distDir?: unknown;
  archiveDir?: unknown;
  keep?: unknown;
  compression?: unknown;
  decompressionFallbacks?: unknown;
  requestTimeout?: unknown;
};

describe("parseCliConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "parse-cli-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeRawCliArgs(overrides: RawCliOverrides = {}): RawCliParseArgs {
    return {
      positionals:
        "positionals" in overrides
          ? (overrides.positionals ?? [])
          : ["https://cdn.example.com/archives"],
      values: {
        dist: "distDir" in overrides ? overrides.distDir : tmpDir,
        "archive-dir": "archiveDir" in overrides ? overrides.archiveDir : "deploy-echoes",
        keep: "keep" in overrides ? overrides.keep : "9",
        compression: "compression" in overrides ? overrides.compression : "gz",
        "decompression-fallback":
          "decompressionFallbacks" in overrides ? overrides.decompressionFallbacks : [],
        "request-timeout": "requestTimeout" in overrides ? overrides.requestTimeout : "30",
      },
    };
  }

  it("returns one canonical runtime config object", () => {
    const config = parseCliConfig(
      makeRawCliArgs({
        archiveDir: "release/../archives",
        keep: "5",
        compression: "none",
        decompressionFallbacks: ["gz"],
        requestTimeout: "0",
      }),
    );

    deepStrictEqual(config, {
      cdnUrl: "https://cdn.example.com/archives",
      distDir: tmpDir,
      archiveDir: "archives",
      keep: 5,
      compression: "none",
      decompressionFallbacks: ["gz"],
      timeoutMs: 0,
    });
  });

  it("rejects a missing cdn url", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ positionals: [] })), {
      message: /Missing required positional argument: <cdn-url>/,
    });
  });

  it("surfaces the exact missing cdn url error", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ positionals: [] })), {
      message: "Missing required positional argument: <cdn-url>",
    });
  });

  it("rejects an HTTP CDN URL", () => {
    throws(
      () => parseCliConfig(makeRawCliArgs({ positionals: ["http://cdn.example.com/archives"] })),
      {
        message: /HTTPS/,
      },
    );
  });

  it("surfaces the protocol name when the CDN URL is not HTTPS", () => {
    throws(
      () => parseCliConfig(makeRawCliArgs({ positionals: ["ftp://cdn.example.com/archives"] })),
      {
        message: "Invalid URL: 'ftp://cdn.example.com/archives' must use HTTPS (got 'ftp')",
      },
    );
  });

  it("rejects a malformed CDN URL", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ positionals: ["not-a-url"] })), {
      message: /Invalid URL/,
    });
  });

  it("surfaces the exact malformed CDN URL", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ positionals: ["not-a-url"] })), {
      message: "Invalid URL: 'not-a-url' is not a valid URL",
    });
  });

  it("defaults missing decompression fallbacks to an empty list", () => {
    const config = parseCliConfig(makeRawCliArgs({ decompressionFallbacks: undefined }));

    deepStrictEqual(config.decompressionFallbacks, []);
  });

  it("normalizes nested archive directories to forward slashes", () => {
    const config = parseCliConfig(makeRawCliArgs({ archiveDir: "nested/archive-dir" }));

    strictEqual(config.archiveDir, "nested/archive-dir");
  });

  it("rejects a missing archive directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: undefined })), {
      message: "Missing required option: --archive-dir",
    });
  });

  it("rejects an empty archive directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: "" })), {
      message: /empty/,
    });
  });

  it("rejects an absolute archive directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: "/tmp/out" })), {
      message: /relative/,
    });
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: "/tmp/out" })), {
      message: /\/tmp\/out/,
    });
  });

  it("rejects an archive directory that escapes --dist", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: "../archives" })), {
      message: /stay under --dist/,
    });
  });

  it("rejects archive-dir='..' because it escapes --dist directly", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: ".." })), {
      message: "Invalid archive directory: '..' must stay under --dist",
    });
  });

  it("rejects an archive directory that collapses to --dist", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ archiveDir: "foo/.." })), {
      message: /cannot resolve to --dist itself/,
    });
  });

  it("rejects a non-numeric keep value", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ keep: "abc" })), {
      message: /not a number/,
    });
  });

  it("rejects a missing keep value", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ keep: undefined })), {
      message: "Missing required option: --keep",
    });
  });

  for (const keep of ["0", "-3", "3.7"]) {
    it(`rejects keep=${keep} because it is not a positive integer`, () => {
      throws(() => parseCliConfig(makeRawCliArgs({ keep })), {
        message: /positive integer/,
      });
    });
  }

  it("rejects a missing dist directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ distDir: undefined })), {
      message: /Missing required option: --dist/,
    });
  });

  it("rejects a flag-like dist directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ distDir: "--verbose" })), {
      message: /flag/,
    });
  });

  it("rejects a non-existent dist directory", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ distDir: "/tmp/does-not-exist-xyz" })), {
      message: /does not exist/,
    });
  });

  it("rejects a file path as --dist", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "hello");

    throws(() => parseCliConfig(makeRawCliArgs({ distDir: filePath })), {
      message: /not a directory/,
    });
  });

  for (const compression of ["zst", "xz", "lz4", "bz2"]) {
    it(`rejects unsupported compression '${compression}'`, () => {
      throws(() => parseCliConfig(makeRawCliArgs({ compression })), {
        message: new RegExp(`'${compression}'[\\s\\S]*gz[\\s\\S]*none`),
      });
    });
  }

  it("rejects a missing compression value", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ compression: undefined })), {
      message: "Missing required option: --compression",
    });
  });

  it("surfaces the exact unsupported compression message", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ compression: "zst" })), {
      message: "Invalid compression: 'zst' is not supported. Supported: gz, none.",
    });
  });

  it("rejects an unsupported decompression fallback", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ decompressionFallbacks: ["xz"] })), {
      message: /'xz'[\s\S]*gz[\s\S]*none/,
    });
  });

  it("rejects a non-list decompression fallback value", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ decompressionFallbacks: "gz" })), {
      message: "Invalid --decompression-fallback value: expected a list of compression names",
    });
  });

  it("rejects a non-string decompression fallback entry", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ decompressionFallbacks: [123] })), {
      message: "Invalid --decompression-fallback value: expected a string compression name",
    });
  });

  it("surfaces the exact unsupported decompression fallback message", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ decompressionFallbacks: ["xz"] })), {
      message: "Invalid compression: 'xz' is not supported. Supported: gz, none.",
    });
  });

  it("rejects a duplicate compression chain when the primary appears as a fallback", () => {
    throws(
      () =>
        parseCliConfig(
          makeRawCliArgs({
            compression: "gz",
            decompressionFallbacks: ["gz"],
          }),
        ),
      {
        message: /gz/,
      },
    );
  });

  it("rejects a duplicate compression chain when a fallback is repeated", () => {
    throws(
      () =>
        parseCliConfig(
          makeRawCliArgs({
            compression: "gz",
            decompressionFallbacks: ["none", "none"],
          }),
        ),
      {
        message: /none/,
      },
    );
  });

  it("surfaces the exact duplicate compression chain", () => {
    throws(
      () =>
        parseCliConfig(
          makeRawCliArgs({
            compression: "gz",
            decompressionFallbacks: ["none", "gz"],
          }),
        ),
      {
        message: "Invalid compression chain: 'gz' appears more than once in [gz, none, gz]",
      },
    );
  });

  it("accepts --request-timeout 0 and returns 0ms", () => {
    const config = parseCliConfig(makeRawCliArgs({ requestTimeout: "0" }));

    strictEqual(config.timeoutMs, 0);
  });

  it("converts request-timeout seconds to milliseconds", () => {
    const config = parseCliConfig(makeRawCliArgs({ requestTimeout: "5" }));

    strictEqual(config.timeoutMs, 5_000);
  });

  it("rejects a missing request-timeout value", () => {
    throws(() => parseCliConfig(makeRawCliArgs({ requestTimeout: undefined })), {
      message: "Missing required option: --request-timeout",
    });
  });

  for (const requestTimeout of [undefined, "", "-1", "1.5", "abc", "30s"]) {
    it(`rejects request-timeout=${String(requestTimeout)}`, () => {
      throws(() => parseCliConfig(makeRawCliArgs({ requestTimeout })), {
        message: /--request-timeout/,
      });
    });
  }
});
