import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..");
const cliPath = join(projectRoot, "src", "cli.ts");
const certPath = join(projectRoot, "e2e", "fixtures", "localhost-cert.pem");

/**
 * Result of a completed {@link runCli} invocation. The CLI's standard streams
 * are fully buffered into memory before this value is produced.
 */
export interface RunCliResult {
  /**
   * Process exit code, or `null` if the child exited because of a signal —
   * notably when the timeout in {@link runCli} forces a `SIGKILL`.
   */
  code: number | null;
  /** Full buffered standard output decoded as UTF-8. */
  stdout: string;
  /** Full buffered standard error decoded as UTF-8. */
  stderr: string;
}

/**
 * Spawns the CLI in a child Node process, waits for it to exit, and returns
 * the captured exit code and buffered stdout/stderr.
 *
 * The child inherits `process.env` merged with `opts.env`, with
 * `NODE_EXTRA_CA_CERTS` always pointed at the localhost test certificate so
 * HTTPS requests to the mock CDN succeed regardless of caller-supplied
 * environment.
 *
 * @param args - Arguments passed to the CLI after the script path.
 * @param opts - Spawn options.
 * @param opts.cwd - Working directory for the child process.
 * @param opts.env - Optional environment overrides merged on top of
 * `process.env`. `NODE_EXTRA_CA_CERTS` is always set by this function and
 * cannot be overridden through this option.
 * @param opts.timeoutMs - Optional kill timeout. When greater than `0`, the
 * child receives `SIGKILL` after this many milliseconds, in which case the
 * resulting `code` is `null`. `0` or omitted disables the timeout.
 * @returns A {@link RunCliResult} with `code`, `stdout`, and `stderr`. The
 * function never throws on non-zero exits; callers should inspect `code`.
 */
export async function runCli(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunCliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    NODE_EXTRA_CA_CERTS: certPath,
  };
  const child = spawn("node", [cliPath, ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const timer =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  if (timer !== undefined) clearTimeout(timer);
  return { code, stdout, stderr };
}
