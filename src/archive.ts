import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { create, extract, list } from "tar";

/**
 * Maps a compression name to the corresponding archive file suffix.
 *
 * @param name - The compression name (e.g. `"gz"`, `"none"`).
 * @returns The archive suffix: `.tar` for `"none"`, otherwise `.tar.<name>`.
 */
export function compressionToSuffix(name: string): string {
  return name === "none" ? ".tar" : `.tar.${name}`;
}

/**
 * Common archive-location options shared by every archive helper. Identifies
 * the dist directory holding the build output and the archive subdirectory
 * inside it.
 */
interface ArchiveLocation {
  /** Path to the dist directory whose build output is being archived or extracted. */
  distDir: string;
  /**
   * Path to the archive subdirectory **relative to `distDir`**, expressed with
   * forward slashes. Helpers join it onto `distDir` to locate the archives.
   */
  archiveDir: string;
}

/**
 * Removes the archive directory (and its contents) from inside `distDir`.
 *
 * @param options - The destructured options bag.
 * @param options.distDir - The dist directory that contains the archive directory.
 * @param options.archiveDir - The archive directory name, relative to `distDir`.
 */
export async function cleanArchiveDir({ distDir, archiveDir }: ArchiveLocation): Promise<void> {
  await rm(join(distDir, archiveDir), { recursive: true, force: true });
}

/**
 * Options for {@link createArchive}. Extends {@link ArchiveLocation} with the
 * compression to apply to the new archive.
 */
interface CreateArchiveOptions extends ArchiveLocation {
  /**
   * Compression name. Drives both the output filename suffix (via
   * {@link compressionToSuffix}) and whether tar gzips the archive: only
   * `"gz"` enables gzip; `"none"` produces a plain `.tar`.
   */
  compression: string;
}

/**
 * Creates a new tar archive of `distDir` (excluding the archive directory itself)
 * at `<distDir>/<archiveDir>/0<suffix>`, where `<suffix>` is derived from `compression`.
 *
 * @param options - The destructured options bag.
 * @param options.distDir - The dist directory whose contents are archived.
 * @param options.archiveDir - The archive directory (relative to `distDir`) that holds the new archive and is itself excluded from the archive's contents.
 * @param options.compression - The compression name; controls the suffix and whether gzip is applied.
 */
export async function createArchive({
  distDir,
  archiveDir,
  compression,
}: CreateArchiveOptions): Promise<void> {
  const archiveDirPath = join(distDir, archiveDir);
  await mkdir(archiveDirPath, { recursive: true });
  const archiveName = `0${compressionToSuffix(compression)}`;
  const archivePath = join(archiveDirPath, archiveName);
  const archiveDirPrefix = `${archiveDir}/`;

  await create(
    {
      file: archivePath,
      cwd: distDir,
      gzip: compression === "gz",
      filter: (path) => {
        // path is relative to cwd, normalized to forward slashes by node-tar.
        // Strip a leading "./" so the comparison works for both "./archives"
        // and "archives/foo" forms.
        const norm = path.replace(/^\.\//, "").replace(/\/$/, "");
        return norm !== archiveDir && !norm.startsWith(archiveDirPrefix);
      },
    },
    ["."],
  );

  console.error(`created ${archiveName}`);
}

/**
 * Lists the entries in the tar archive at `archivePath` and throws if any entry is unsafe:
 * an entry whose type is anything other than a plain file or directory, or whose path contains
 * a `..` segment. Returns normally when every entry is safe.
 *
 * @param archivePath - The path to the tar archive to inspect.
 */
export async function validateArchiveContents(archivePath: string): Promise<void> {
  const offenders: string[] = [];
  await list({
    file: archivePath,
    onentry: (entry) => {
      const isSafeType = entry.type === "File" || entry.type === "Directory";
      const hasDotDotSegment = entry.path.split("/").some((segment) => segment === "..");
      if (isSafeType && !hasDotDotSegment) return;

      const isLink = entry.type === "SymbolicLink" || entry.type === "Link";
      const linkpathSuffix = isLink ? ` linkpath=${entry.linkpath ?? ""}` : "";
      offenders.push(`type=${entry.type} path=${entry.path}${linkpathSuffix}`);
    },
  });
  if (offenders.length > 0) {
    throw new Error(["Unsafe entries in archive:", ...offenders].join("\n"));
  }
}

/**
 * Extracts the leading numeric index from an archive filename, used to sort
 * archives in ascending index order.
 *
 * @param filename - The archive filename to inspect.
 * @returns The parsed archive index, or `NaN` when `filename` does not start with a digit.
 */
function archiveIndexFromFilename(filename: string): number {
  const match = filename.match(/^(\d+)/);
  return match === null ? Number.NaN : Number(match[1]);
}

/**
 * Options for {@link extractArchives}. Extends {@link ArchiveLocation} with
 * the set of archive filename suffixes that drive archive discovery.
 */
interface ExtractArchivesOptions extends ArchiveLocation {
  /**
   * Accepted archive filename suffixes (e.g. `[".tar.gz", ".tar"]`). Files in
   * `archiveDir` that do not end in one of these suffixes — or whose name
   * does not start with a numeric index — are ignored entirely; only matching
   * archives are validated and extracted, in ascending index order.
   */
  suffixes: string[];
}

/**
 * Extracts every archive in `<distDir>/<archiveDir>` whose filename ends in one of `suffixes`,
 * in ascending order of the leading integer in each filename. Extraction uses tar's
 * `--skip-old-files` semantics so archive `0` (the newest) wins on path conflicts with older
 * archives, while each archive's contents are first vetted by `validateArchiveContents`.
 *
 * @param options - The destructured options bag.
 * @param options.distDir - The dist directory that contains the archive directory and receives the extracted files.
 * @param options.archiveDir - The archive directory, relative to `distDir`, holding the archives to extract.
 * @param options.suffixes - The accepted archive suffixes (e.g. `[".tar.gz", ".tar"]`); files in `archiveDir` whose names do not end in one of these are ignored.
 */
export async function extractArchives({
  distDir,
  archiveDir,
  suffixes,
}: ExtractArchivesOptions): Promise<void> {
  const archiveDirPath = join(distDir, archiveDir);
  const files = await readdir(archiveDirPath);
  const archives = files
    .filter(
      (f) => suffixes.some((s) => f.endsWith(s)) && !Number.isNaN(archiveIndexFromFilename(f)),
    )
    // Archives are sorted ascending (0, 1, 2, ...) and extracted in that order.
    // tar's --skip-old-files flag means the first archive extracted wins for
    // conflicting paths — so archive 0 (the newest) takes priority over older
    // archives. This is the intended behavior.
    .toSorted((a, b) => archiveIndexFromFilename(a) - archiveIndexFromFilename(b));

  for (const archive of archives) {
    const archivePath = join(archiveDirPath, archive);
    await validateArchiveContents(archivePath);
    let newCount = 0;
    await extract({
      file: archivePath,
      cwd: distDir,
      keep: true,
      onentry: () => {
        newCount += 1;
      },
    });
    console.error(`extracted ${archive} (+${newCount})`);
  }
}
