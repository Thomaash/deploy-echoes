import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

/**
 * Per-archive scenario response served by the mock CDN. The active variant
 * determines what the server does when the matching archive name is
 * requested:
 *
 * - `Buffer` — respond `200` with the buffer as the body and a
 *   compression-aware `Content-Type` (`application/gzip` for `.gz`,
 *   otherwise `application/x-tar`).
 * - `{ status }` — respond with the given status code and an empty body
 *   (used to simulate `404`, `5xx`, etc.).
 * - `{ delayMs, body }` — wait `delayMs` milliseconds after sending headers,
 *   then write `body` and end the response. Used to verify that
 *   `--request-timeout 0` disables the per-attempt timeout.
 * - `{ delayMs }` (no `body`) — flush headers immediately and never write
 *   the body, leaving the CLI's per-request `AbortSignal` to close the
 *   socket when its timeout fires.
 */
export type ArchiveEntry =
  | Buffer
  | { status: number }
  | { delayMs: number }
  | { delayMs: number; body: Buffer };

/**
 * One entry in the mock CDN's live request log. Entries are appended as
 * requests arrive, so tests can assert which paths were fetched and in what
 * order after triggering CLI behaviour.
 */
export interface RequestLogEntry {
  /** HTTP method as reported by Node, defaulting to `"GET"` if absent. */
  method: string;
  /** Request URL path including any query string, exactly as supplied by Node's HTTP server. */
  path: string;
}

/**
 * Handle to a running mock CDN returned by {@link startMockCdn}. Tests use
 * `url` as the CLI's `<cdn-url>`, observe `requestLog` to assert traffic,
 * and must call `close` to release the listening port when finished.
 */
export interface MockCdn {
  /** HTTPS base URL for the server, e.g. `https://localhost:<port>`. */
  url: string;
  /**
   * Live, append-only request log. Observed in tests after triggering CLI
   * behaviour to assert which archive paths were fetched and in what order.
   */
  requestLog: RequestLogEntry[];
  /**
   * Stops the server, forcefully closes any open connections, and resolves
   * once shutdown completes. Tests must call this to release the listening
   * port; failing to do so leaks the server between tests.
   */
  close: () => Promise<void>;
}

/**
 * Starts an HTTPS mock CDN backed by the localhost test certificate in
 * `e2e/fixtures/`, listening on a random ephemeral port on `127.0.0.1`.
 *
 * Each incoming request is appended to {@link MockCdn.requestLog}. The
 * server then looks up the requested archive by its **basename** (everything
 * after the final `/`) in `scenario.archives` and responds according to the
 * matched {@link ArchiveEntry} variant; basenames not present in the map
 * receive a `404`. `Buffer` entries pick a `Content-Type` of
 * `application/gzip` or `application/x-tar` based on the requested
 * filename's `.gz` suffix.
 *
 * Callers must invoke {@link MockCdn.close} when the test ends to free the
 * port and stop the server.
 *
 * @param scenario - Scenario describing how the server should respond.
 * @param scenario.archives - Map from archive basename (e.g. `"0.tar.gz"`)
 * to the response variant served for that archive.
 * @returns A {@link MockCdn} handle exposing the live URL, request log, and
 * shutdown function.
 */
export async function startMockCdn(scenario: {
  archives: Map<string, ArchiveEntry>;
}): Promise<MockCdn> {
  const cert = readFileSync(join(fixtures, "localhost-cert.pem"));
  const key = readFileSync(join(fixtures, "localhost-key.pem"));
  const requestLog: RequestLogEntry[] = [];

  const server = createServer({ cert, key }, (req, res) => {
    const path = req.url ?? "";
    requestLog.push({ method: req.method ?? "GET", path });
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const entry = scenario.archives.get(basename);
    if (entry === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (Buffer.isBuffer(entry)) {
      res.statusCode = 200;
      res.setHeader(
        "content-type",
        basename.endsWith(".gz") ? "application/gzip" : "application/x-tar",
      );
      res.end(entry);
      return;
    }
    if ("status" in entry) {
      res.statusCode = entry.status;
      res.end();
      return;
    }
    // { delayMs, body }: response body delivered after delay; used to prove
    // `--request-timeout 0` disables the per-attempt timeout (cli-e2e-tests scenario 6).
    if ("body" in entry) {
      res.statusCode = 200;
      res.setHeader(
        "content-type",
        basename.endsWith(".gz") ? "application/gzip" : "application/x-tar",
      );
      setTimeout(() => res.end(entry.body), entry.delayMs);
      return;
    }
    // delayMs (no body): send headers immediately, never write the body. The CLI's
    // per-request AbortSignal will close the socket when the timeout fires.
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-tar");
    res.flushHeaders();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("mock CDN: unexpected server address");
  }
  const url = `https://localhost:${addr.port}`;

  return {
    url,
    requestLog,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
