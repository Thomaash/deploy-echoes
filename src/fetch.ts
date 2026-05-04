import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Tries each suffix in `suffixes` for the upstream archive at `index`, fetching the first
 * candidate that does not respond with HTTP 404 and writing it to
 * `<distDir>/<archiveDir>/<index + 1><suffix>`. The local index is offset by one because
 * archive `0` is reserved for the freshly-built local archive; upstream `index` lands at
 * local `index + 1`.
 *
 * Throws on non-404 HTTP errors, fetch/network errors (including AbortSignal timeouts), and
 * stream-pipeline errors. Successful 404s on every suffix in the chain are not errors —
 * they signal end-of-sequence to the caller.
 *
 * @param options - The destructured options bag.
 * @param options.cdnUrl - The CDN base URL; a trailing `/` is appended if absent before resolving.
 * @param options.distDir - The dist directory that contains the archive directory.
 * @param options.archiveDir - The archive directory, relative to `distDir`, where the fetched archive is written.
 * @param options.index - The upstream archive index to fetch (the local destination is `index + 1`).
 * @param options.suffixes - The ordered suffix chain to probe (e.g. `[".tar.gz", ".tar"]`); the first non-404 wins.
 * @param options.timeoutMs - Per-request timeout in milliseconds; `0` disables the timeout.
 * @returns `true` when one of the suffix candidates was fetched and written to disk; `false` when every candidate in the chain returned 404 (the index is exhausted and the caller should stop iterating).
 */
async function tryFetchArchiveAtIndex({
  cdnUrl,
  distDir,
  archiveDir,
  index,
  suffixes,
  timeoutMs,
}: {
  cdnUrl: string;
  distDir: string;
  archiveDir: string;
  index: number;
  suffixes: string[];
  timeoutMs: number;
}): Promise<boolean> {
  const base = cdnUrl.endsWith("/") ? cdnUrl : `${cdnUrl}/`;
  for (const suffix of suffixes) {
    const url = new URL(`${index}${suffix}`, base).toString();
    const dest = join(distDir, archiveDir, `${index + 1}${suffix}`);
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch archive ${index} (${suffix}) at ${url}: ${message}`, {
        cause: error,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch archive ${index} (${suffix}) at ${url}: HTTP ${response.status}`,
      );
    }
    if (!response.body) {
      throw new Error(
        `Failed to fetch archive ${index} (${suffix}) at ${url}: response had no body`,
      );
    }
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(dest), { signal });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch archive ${index} (${suffix}) at ${url}: ${message}`, {
        cause: error,
      });
    }
    console.error(`fetched ${index + 1}${suffix}`);
    return true;
  }
  return false;
}

/**
 * Fetches up to `keep` previous archives from the CDN into `<distDir>/<archiveDir>`,
 * iterating upstream indexes `0..keep-1` and stopping early on the first index where every
 * suffix in the chain returns HTTP 404 (end-of-sequence sentinel; the loop also logs
 * `"no more archives on cdn"` to stderr when this happens).
 *
 * @param options - The destructured options bag.
 * @param options.cdnUrl - The CDN base URL.
 * @param options.distDir - The dist directory that contains the archive directory.
 * @param options.archiveDir - The archive directory, relative to `distDir`, where fetched archives are written.
 * @param options.keep - The maximum number of upstream indexes to fetch (`0..keep-1`).
 * @param options.suffixes - The ordered suffix chain passed through to each per-index fetch attempt.
 * @param options.timeoutMs - Per-request timeout in milliseconds; `0` disables the timeout.
 */
export async function fetchPreviousArchives({
  cdnUrl,
  distDir,
  archiveDir,
  keep,
  suffixes,
  timeoutMs,
}: {
  cdnUrl: string;
  distDir: string;
  archiveDir: string;
  keep: number;
  suffixes: string[];
  timeoutMs: number;
}): Promise<void> {
  await mkdir(join(distDir, archiveDir), { recursive: true });

  for (let i = 0; i < keep; i++) {
    const found = await tryFetchArchiveAtIndex({
      cdnUrl,
      distDir,
      archiveDir,
      index: i,
      suffixes,
      timeoutMs,
    });
    if (!found) {
      // Every entry in the suffix chain returned 404 for this index — end of sequence.
      console.error("no more archives on cdn");
      break;
    }
  }
}
