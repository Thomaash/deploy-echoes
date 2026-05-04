import type { Stats } from "node:fs";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Canonical, ordered list of compression names recognised by the CLI. Acts as
 * the single source of truth for `--compression` and `--decompression-fallback`
 * validation and as the basis for {@link CompressionName}.
 */
export const SUPPORTED_COMPRESSIONS = ["gz", "none"] as const;

/**
 * Normalised compression-name string. Always one of the entries in
 * {@link SUPPORTED_COMPRESSIONS}; a value of this type is guaranteed to have
 * passed CLI compression validation.
 */
type CompressionName = (typeof SUPPORTED_COMPRESSIONS)[number];

/**
 * Raw shape of CLI input as produced by `node:util`'s `parseArgs`, before any
 * normalisation or validation.
 *
 * Each option value is typed as `unknown` so that the Zod pipeline in this
 * module remains the single owner of validation; callers should not narrow
 * these fields manually. Pass an object of this shape to
 * {@link parseCliConfig} to obtain a validated {@link CliConfig}.
 */
export type RawCliParseArgs = {
  /** Option flags by their CLI long-name; each entry is left as `unknown` for the validator to inspect. */
  values: {
    dist?: unknown;
    "archive-dir"?: unknown;
    keep?: unknown;
    compression?: unknown;
    "decompression-fallback"?: unknown;
    "request-timeout"?: unknown;
  };
  /** Positional arguments in the order supplied. Index `0` is the `<cdn-url>` argument. */
  positionals: readonly unknown[];
};

/**
 * Fully validated, normalised CLI configuration produced by
 * {@link parseCliConfig}. Holding a value of this type implies that every
 * field already passed CLI-time validation and the appropriate
 * normalisations have been applied.
 */
export type CliConfig = {
  /** The CDN URL exactly as supplied; guaranteed to parse as a URL using `https:`. */
  cdnUrl: string;
  /** The dist directory path as supplied; guaranteed to exist and to be a directory at parse time. */
  distDir: string;
  /**
   * The archive directory **relative to `distDir`**, expressed with forward
   * slashes; guaranteed to stay strictly under `distDir` (never escapes and
   * never equals `distDir` itself).
   */
  archiveDir: string;
  /** Number of archives to keep. Positive integer. */
  keep: number;
  /** Compression to use when creating new archives. */
  compression: CompressionName;
  /**
   * Additional compressions to accept when extracting archives. Never
   * contains `compression` and contains no duplicate entries.
   */
  decompressionFallbacks: CompressionName[];
  /**
   * Per-request timeout in **milliseconds**. The `--request-timeout` CLI
   * option is supplied in seconds; the parser converts it. A value of `0`
   * disables the timeout.
   */
  timeoutMs: number;
};

/**
 * Resolves `archiveDir` to a path **relative to `distDir`**, normalised with
 * forward-slash separators, while ensuring the archive directory stays
 * strictly under the dist directory.
 *
 * `distDir` is resolved against the current working directory if not
 * absolute; `archiveDir` is then joined onto that resolved dist directory
 * before being expressed relative to it.
 *
 * @param distDir - The dist directory; resolved against `process.cwd()` if
 * not absolute.
 * @param archiveDir - The archive directory, joined onto the resolved
 * `distDir` to determine its location.
 * @returns The archive directory expressed relative to `distDir`, with
 * forward-slash separators.
 * @throws {Error} If `archiveDir` resolves to `distDir` itself, or escapes
 * outside `distDir` (parent traversal or absolute relative path).
 */
function resolveArchiveDir(distDir: string, archiveDir: string): string {
  const resolvedDistDir = resolve(distDir);
  const resolvedArchiveDir = resolve(resolvedDistDir, archiveDir);
  const relativeArchiveDir = relative(resolvedDistDir, resolvedArchiveDir);

  if (relativeArchiveDir === "") {
    throw new Error(
      `Invalid archive directory: '${archiveDir}' must stay under --dist and cannot resolve to --dist itself`,
    );
  }
  if (
    relativeArchiveDir === ".." ||
    relativeArchiveDir.startsWith(`..${sep}`) ||
    isAbsolute(relativeArchiveDir)
  ) {
    throw new Error(`Invalid archive directory: '${archiveDir}' must stay under --dist`);
  }

  return relativeArchiveDir.split(sep).join("/");
}

/**
 * Zod schema for the `<cdn-url>` positional argument. Requires a
 * syntactically valid URL using the `https:` protocol; emits CLI-flavoured
 * error messages distinguishing missing input, malformed URLs, and
 * non-HTTPS protocols. Used as the `cdnUrl` member of {@link cliConfigSchema}.
 */
const cdnUrlSchema = z
  .url({
    error: (issue) => {
      if (issue.code === "invalid_type") return "Missing required positional argument: <cdn-url>";
      if (issue.code === "invalid_format") {
        return `Invalid URL: '${String(issue.input)}' is not a valid URL`;
      }
      return undefined;
    },
  })
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return true;
      }
    },
    {
      error: (issue) => {
        const value = String(issue.input);
        const protocol = new URL(value).protocol.replace(":", "");
        return `Invalid URL: '${value}' must use HTTPS (got '${protocol}')`;
      },
    },
  );

/**
 * Zod schema for the `--archive-dir` option, performing **syntactic** checks
 * only: requires a non-empty string that is not absolute. Cross-field path
 * resolution (escape detection, equality with `--dist`) happens later in
 * {@link cliConfigSchema} via {@link resolveArchiveDir}.
 */
const archiveDirSchema = z
  .string({
    error: (issue) =>
      issue.code === "invalid_type" ? "Missing required option: --archive-dir" : undefined,
  })
  .min(1, { error: "Invalid archive directory: directory name cannot be empty" })
  .refine((value) => !isAbsolute(value), {
    error: (issue) =>
      `Invalid archive directory: '${String(issue.input)}' must be relative to --dist`,
  });

/**
 * Zod schema for the `--keep` option. Coerces the string CLI input into a
 * number and requires a positive integer; emits CLI-flavoured error messages
 * distinguishing missing input, non-numeric input, and non-positive integers.
 */
const keepSchema = z
  .string({
    error: (issue) =>
      issue.code === "invalid_type" ? "Missing required option: --keep" : undefined,
  })
  .pipe(
    z.coerce
      .number<string>({
        error: (issue) => `Invalid keep value: '${String(issue.input)}' is not a number`,
      })
      .int({
        error: (issue) => `Invalid keep value: '${String(issue.input)}' must be a positive integer`,
      })
      .positive({
        error: (issue) => `Invalid keep value: '${String(issue.input)}' must be a positive integer`,
      }),
  );

/**
 * Zod schema for the `--compression` option. Accepts only values listed in
 * {@link SUPPORTED_COMPRESSIONS}; emits CLI-flavoured error messages
 * distinguishing missing input from unsupported names.
 */
const compressionSchema = z.enum(SUPPORTED_COMPRESSIONS, {
  error: (issue) => {
    if (issue.code !== "invalid_value") return undefined;
    if (typeof issue.input !== "string") return "Missing required option: --compression";
    return `Invalid compression: '${issue.input}' is not supported. Supported: ${SUPPORTED_COMPRESSIONS.join(", ")}.`;
  },
});

/**
 * Zod schema for the `--decompression-fallback` option. Accepts a list of
 * names from {@link SUPPORTED_COMPRESSIONS} and defaults to `[]` when the
 * option is absent. Emits distinct error messages for non-list input
 * (wrong type), non-string list elements, and unsupported names. Cross-field
 * checks (no overlap with `--compression`, no duplicates) live in
 * {@link cliConfigSchema}.
 */
const decompressionFallbacksSchema = z
  .array(
    z.enum(SUPPORTED_COMPRESSIONS, {
      error: (issue) => {
        if (issue.code !== "invalid_value") return undefined;
        if (typeof issue.input !== "string") {
          return "Invalid --decompression-fallback value: expected a string compression name";
        }
        return `Invalid compression: '${issue.input}' is not supported. Supported: ${SUPPORTED_COMPRESSIONS.join(", ")}.`;
      },
    }),
    {
      error: (issue) =>
        issue.code === "invalid_type"
          ? "Invalid --decompression-fallback value: expected a list of compression names"
          : undefined,
    },
  )
  .default([]);

/**
 * Zod schema for the `--request-timeout` option. The CLI input is a string
 * representing a non-negative integer number of **seconds**; the schema
 * validates it and transforms the result into **milliseconds**, so consumers
 * read a ready-to-use timeout from {@link CliConfig.timeoutMs}. A value of
 * `0` is permitted and disables the per-request timeout.
 */
const timeoutMsSchema = z
  .string({
    error: (issue) =>
      issue.code === "invalid_type" ? "Missing required option: --request-timeout" : undefined,
  })
  .min(1, { error: "Missing required option: --request-timeout" })
  .pipe(
    z.coerce
      .number<string>({
        error: (issue) =>
          `Invalid --request-timeout value: '${String(issue.input)}' must be a non-negative integer of seconds`,
      })
      .int({
        error: (issue) =>
          `Invalid --request-timeout value: '${String(issue.input)}' must be a non-negative integer of seconds`,
      })
      .nonnegative({
        error: (issue) =>
          `Invalid --request-timeout value: '${String(issue.input)}' must be a non-negative integer of seconds`,
      }),
  )
  .transform((seconds) => seconds * 1000);

/**
 * Zod schema for the `--dist` option. Performs filesystem-based validation
 * via a synchronous `statSync` (placed in a custom refinement because
 * `statSync` cannot be expressed with built-in Zod constraints): the value
 * must not look like a CLI flag, must exist on disk, and must point at a
 * directory. Each failure mode produces a distinct CLI-flavoured error
 * message.
 */
const distDirSchema = z
  .string({
    error: (issue) =>
      issue.code === "invalid_type" ? "Missing required option: --dist" : undefined,
  })
  .superRefine((value, ctx) => {
    if (value.startsWith("-")) {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: `Invalid dist directory: '${value}' looks like a flag, not a directory name`,
      });
      return;
    }

    let stats: Stats;
    try {
      stats = statSync(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: `Dist directory not found: '${value}' does not exist`,
      });
      return;
    }
    if (!stats.isDirectory()) {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: `Invalid dist directory: '${value}' is not a directory`,
      });
    }
  });

/**
 * Zod schema that combines every per-field schema in this module, then
 * performs the cross-field validation and transformation that produces a
 * fully normalised {@link CliConfig}:
 *
 * - rejects duplicate compressions across the chain
 *   `[compression, ...decompressionFallbacks]` (so each compression appears
 *   at most once when extracting)
 * - resolves `archiveDir` to its `distDir`-relative form via
 *   {@link resolveArchiveDir}, surfacing escape and `archiveDir === distDir`
 *   failures as Zod issues on the `archiveDir` path
 *
 * The output type is {@link CliConfig}.
 */
const cliConfigSchema = z
  .object({
    cdnUrl: cdnUrlSchema,
    distDir: distDirSchema,
    archiveDir: archiveDirSchema,
    keep: keepSchema,
    compression: compressionSchema,
    decompressionFallbacks: decompressionFallbacksSchema,
    timeoutMs: timeoutMsSchema,
  })
  .superRefine((value, ctx) => {
    const chain: CompressionName[] = [value.compression, ...value.decompressionFallbacks];
    const seen = new Set<string>();
    for (const name of chain) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          input: chain,
          path: ["decompressionFallbacks"],
          message: `Invalid compression chain: '${name}' appears more than once in [${chain.join(", ")}]`,
        });
        return;
      }
      seen.add(name);
    }
  })
  .transform((input, ctx): CliConfig => {
    let archiveDir: string;
    try {
      archiveDir = resolveArchiveDir(input.distDir, input.archiveDir);
    } catch (error: unknown) {
      ctx.addIssue({
        code: "custom",
        input: input.archiveDir,
        path: ["archiveDir"],
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }

    return {
      cdnUrl: input.cdnUrl,
      distDir: input.distDir,
      archiveDir,
      keep: input.keep,
      compression: input.compression,
      decompressionFallbacks: input.decompressionFallbacks,
      timeoutMs: input.timeoutMs,
    };
  });

/**
 * Validates and normalises raw CLI input into a {@link CliConfig}.
 *
 * Pulls `cdnUrl` from `raw.positionals[0]` and the remaining options from
 * `raw.values` using their CLI long-name keys, then runs the combined
 * {@link cliConfigSchema}.
 *
 * @param raw - The raw `parseArgs` output. Index `0` of `positionals`
 * supplies `cdnUrl`; entries of `values` supply the options.
 * @returns The fully validated, normalised configuration.
 * @throws {Error} On any validation failure. The thrown message is taken
 * from the first Zod issue so it can be reported directly to the CLI user.
 */
export function parseCliConfig(raw: RawCliParseArgs): CliConfig {
  const result = cliConfigSchema.safeParse({
    cdnUrl: raw.positionals[0],
    distDir: raw.values.dist,
    archiveDir: raw.values["archive-dir"],
    keep: raw.values.keep,
    compression: raw.values.compression,
    decompressionFallbacks: raw.values["decompression-fallback"],
    timeoutMs: raw.values["request-timeout"],
  });

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid CLI configuration");
  }

  return result.data;
}
