#!/usr/bin/env node

import { parseArgs } from "node:util";

import { cleanArchiveDir, compressionToSuffix, createArchive, extractArchives } from "./archive.ts";
import { parseCliConfig } from "./cli-config.ts";
import { fetchPreviousArchives } from "./fetch.ts";

const USAGE = `Usage: deploy-echoes <archive-directory-url> [options]

Arguments:
  <archive-directory-url>         Public HTTPS URL where existing archives are hosted.

Options:
  --help                          Show this help and exit.
  --dist <path>                   Build output directory; must exist (default: ./dist).
  --archive-dir <path>            Directory under --dist where archives are written; must be a path relative to --dist (default: deploy-echoes).
  --keep <n>                      Previous archives to fetch alongside the new one; positive integer (default: 9).
  --compression <name>            Compression for new archives. Names: gz (default), none.
  --decompression-fallback <name> Fallback compression for fetching older archives. Names: gz, none. Repeatable; applied in order on 404 during fetch; never used during create.
  --request-timeout <seconds>     Per-attempt fetch timeout in seconds; non-negative integer; 0 disables (default: 30).`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", default: false },
    dist: { type: "string", default: "./dist" },
    "archive-dir": { type: "string", default: "deploy-echoes" },
    keep: { type: "string", default: "9" },
    compression: { type: "string", default: "gz" },
    "decompression-fallback": { type: "string", multiple: true, default: [] },
    "request-timeout": { type: "string", default: "30" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const { cdnUrl, distDir, archiveDir, keep, compression, decompressionFallbacks, timeoutMs } =
    parseCliConfig({ values, positionals });

  const suffixes = [compression, ...decompressionFallbacks].map(compressionToSuffix);

  await cleanArchiveDir({ distDir, archiveDir });
  await createArchive({ distDir, archiveDir, compression });
  await fetchPreviousArchives({ cdnUrl, distDir, archiveDir, keep, suffixes, timeoutMs });
  await extractArchives({ distDir, archiveDir, suffixes });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
