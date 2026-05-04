import { rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach, mock } from "node:test";

import { fetchPreviousArchives } from "./fetch.ts";

const TEST_TIMEOUT_MS = 30_000;

function assertString(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string") throw new TypeError(`expected ${label} to be string, got ${typeof v}`);
}

function createAbortAwarePendingFetch(): (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response> {
  // The keepalive timer is the test double's own event-loop anchor: relying on
  // the production AbortSignal.timeout() alone has been observed to let the
  // event loop go idle on Node 22 before the abort fires, hanging the test.
  const KEEPALIVE_MS = 60_000;
  return (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      let keepalive: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const onKeepaliveExpired = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(new Error("test keepalive expired before abort"));
      };
      const cleanup = () => {
        if (keepalive !== undefined) clearTimeout(keepalive);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      keepalive = setTimeout(onKeepaliveExpired, KEEPALIVE_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

describe("fetchPreviousArchives", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fetch-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("downloads and renumbers archives correctly", async () => {
    const dummyBytes = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      const idx = Number.parseInt(url.split("/").pop()!.replace(".tar.gz", ""), 10);
      return new Response(dummyBytes[idx]);
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/archives",
      distDir,
      archiveDir: "archives",
      keep: 3,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    // Verify fetch was called with correct CDN URLs
    strictEqual(fetchMock.mock.callCount(), 3);
    strictEqual(fetchMock.mock.calls[0]!.arguments[0], "https://cdn.example.com/archives/0.tar.gz");
    strictEqual(fetchMock.mock.calls[1]!.arguments[0], "https://cdn.example.com/archives/1.tar.gz");
    strictEqual(fetchMock.mock.calls[2]!.arguments[0], "https://cdn.example.com/archives/2.tar.gz");

    // Verify files saved at correct renumbered paths
    const archiveDir = join(distDir, "archives");
    const file1 = await readFile(join(archiveDir, "1.tar.gz"));
    const file2 = await readFile(join(archiveDir, "2.tar.gz"));
    const file3 = await readFile(join(archiveDir, "3.tar.gz"));

    strictEqual(Buffer.compare(file1, Buffer.from(dummyBytes[0]!)), 0);
    strictEqual(Buffer.compare(file2, Buffer.from(dummyBytes[1]!)), 0);
    strictEqual(Buffer.compare(file3, Buffer.from(dummyBytes[2]!)), 0);
  });

  it("handles HTTP errors gracefully", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      const idx = Number.parseInt(url.split("/").pop()!.replace(".tar.gz", ""), 10);
      if (idx === 1) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      return new Response(new Uint8Array([idx]));
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/archives",
      distDir,
      archiveDir: "archives",
      keep: 3,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    // Only 2 fetches attempted (0 and 1; 404 at 1 stops the loop)
    strictEqual(fetchMock.mock.callCount(), 2);

    // Only archive 1.tar.gz written (index 0); 404 at index 1 breaks, index 2 never fetched
    const archiveDir = join(distDir, "archives");
    const files = await readdir(archiveDir);
    const tarFiles = files.filter((f: string) => f.endsWith(".tar.gz"));
    strictEqual(tarFiles.length, 1);
    strictEqual(tarFiles.includes("1.tar.gz"), true);
  });

  it("throws on non-404 HTTP errors", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      const idx = Number.parseInt(url.split("/").pop()!.replace(".tar.gz", ""), 10);
      if (idx === 1) {
        return new Response(null, { status: 500, statusText: "Internal Server Error" });
      }
      return new Response(new Uint8Array([idx]));
    });

    const distDir = join(tmpDir, "dist");
    let thrown = false;
    try {
      await fetchPreviousArchives({
        cdnUrl: "https://cdn.example.com/archives",
        distDir,
        archiveDir: "archives",
        keep: 3,
        suffixes: [".tar.gz"],
        timeoutMs: TEST_TIMEOUT_MS,
      });
    } catch (error) {
      thrown = true;
      if (!(error instanceof Error))
        throw new TypeError("expected Error instance", { cause: error });
      strictEqual(error.message.includes("500"), true, "error should include status code");
    }
    strictEqual(thrown, true, "should have thrown");

    // Archive 1.tar.gz (index 0) was still written before the error at index 1
    const archiveDir = join(distDir, "archives");
    const files = await readdir(archiveDir);
    const tarFiles = files.filter((f: string) => f.endsWith(".tar.gz"));
    strictEqual(tarFiles.includes("1.tar.gz"), true, "should write archive for index 0");
  });

  it("handles network errors gracefully", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      const idx = Number.parseInt(url.split("/").pop()!.replace(".tar.gz", ""), 10);
      if (idx === 0) {
        throw new TypeError("fetch failed");
      }
      return new Response(new Uint8Array([idx]));
    });

    const distDir = join(tmpDir, "dist");
    let thrown = false;
    try {
      await fetchPreviousArchives({
        cdnUrl: "https://cdn.example.com/archives",
        distDir,
        archiveDir: "archives",
        keep: 3,
        suffixes: [".tar.gz"],
        timeoutMs: TEST_TIMEOUT_MS,
      });
    } catch (error) {
      thrown = true;
      if (!(error instanceof Error))
        throw new TypeError("expected Error instance", { cause: error });
      strictEqual(
        error.message.includes("fetch failed"),
        true,
        "error should include original message",
      );
    }
    strictEqual(thrown, true, "should have thrown");

    // No files written (error on first fetch)
    const archiveDir = join(distDir, "archives");
    const files = await readdir(archiveDir);
    const tarFiles = files.filter((f: string) => f.endsWith(".tar.gz"));
    strictEqual(tarFiles.length, 0, "no archives should be written");
  });

  it("creates archive directory if it does not exist", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(new Uint8Array([1]));
    });

    const distDir = join(tmpDir, "dist");
    const archiveDir = join(distDir, "new-archives");

    // Directory does not exist before call
    let exists = false;
    try {
      await stat(archiveDir);
      exists = true;
    } catch {
      // expected
    }
    strictEqual(exists, false, "archive dir should not exist before call");

    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com",
      distDir,
      archiveDir: "new-archives",
      keep: 1,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    // Directory now exists
    const dirStat = await stat(archiveDir);
    strictEqual(dirStat.isDirectory(), true, "archive dir should be created");
  });
});

describe("fetchPreviousArchives chain walk", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fetch-chain-test-"));
    mock.method(console, "error", () => {});
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("requests only the primary URL when the primary returns 200", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/0.tar.zst")) {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      // Anything else for index 1+ is 404 to end the sequence quickly.
      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "archives",
      keep: 3,
      suffixes: [".tar.zst", ".tar.gz", ".tar"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    // For index 0, only the primary should have been requested.
    const index0Calls = fetchMock.mock.calls
      .map((c) => {
        const [url] = c.arguments;
        assertString(url, "fetch URL arg");
        return url;
      })
      .filter((u) => /\/0\.tar(\.|$)/.test(u));
    strictEqual(
      index0Calls.length,
      1,
      `expected exactly one request for index 0; got ${JSON.stringify(index0Calls)}`,
    );
    strictEqual(index0Calls[0], "https://cdn.example.com/a/0.tar.zst");

    // The saved file uses the primary suffix.
    const archiveDir = join(distDir, "archives");
    const saved = await readFile(join(archiveDir, "1.tar.zst"));
    strictEqual(Buffer.compare(saved, Buffer.from(new Uint8Array([1, 2, 3]))), 0);
  });

  it("walks the chain on 404 and saves with the suffix that succeeded", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/0.tar.zst")) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      if (url.endsWith("/0.tar.gz")) {
        return new Response(new Uint8Array([9, 9, 9]));
      }
      // Index 1 — both 404 to end sequence.
      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "archives",
      keep: 3,
      suffixes: [".tar.zst", ".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const index0Urls = fetchMock.mock.calls
      .map((c) => {
        const [url] = c.arguments;
        assertString(url, "fetch URL arg");
        return url;
      })
      .filter((u) => /\/0\.tar(\.|$)/.test(u));
    strictEqual(
      index0Urls.length,
      2,
      `expected two requests for index 0; got ${JSON.stringify(index0Urls)}`,
    );
    strictEqual(index0Urls[0], "https://cdn.example.com/a/0.tar.zst");
    strictEqual(index0Urls[1], "https://cdn.example.com/a/0.tar.gz");

    // Saved file uses the suffix of the chain entry that returned 200.
    const archiveDir = join(distDir, "archives");
    const saved = await readFile(join(archiveDir, "1.tar.gz"));
    strictEqual(Buffer.compare(saved, Buffer.from(new Uint8Array([9, 9, 9]))), 0);
  });

  it("ends the outer loop only when every chain entry 404s for the same index", async () => {
    // Always 404; loop should still try every chain entry for index 0,
    // see all-404, treat that as end-of-sequence, and not request index 1+.
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "archives",
      keep: 9,
      suffixes: [".tar.zst", ".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const urls = fetchMock.mock.calls.map((c) => {
      const [url] = c.arguments;
      assertString(url, "fetch URL arg");
      return url;
    });
    // Only index 0 was probed (both chain entries), and the loop stopped.
    strictEqual(urls.length, 2, `expected exactly 2 requests; got ${JSON.stringify(urls)}`);
    strictEqual(urls[0], "https://cdn.example.com/a/0.tar.zst");
    strictEqual(urls[1], "https://cdn.example.com/a/0.tar.gz");
    // No index 1+ should appear.
    const sawLater = urls.some((u) => /\/[1-9]\.tar(\.|$)/.test(u));
    strictEqual(
      sawLater,
      false,
      `loop should stop after all-404 at index 0; saw: ${JSON.stringify(urls)}`,
    );
  });

  it("stops after index 5 when every chain entry 404s for index 5", async () => {
    // Return 200 for indices 0..4 (primary), 404 for everything at index 5.
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      const match = /\/(\d+)\.tar(\.[^/]+)?$/.exec(url);
      if (!match) return new Response(null, { status: 404 });
      const idx = Number.parseInt(match[1]!, 10);
      const suffix = match[2] ?? "";
      if (idx <= 4 && suffix === ".zst") {
        return new Response(new Uint8Array([idx]));
      }
      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "archives",
      keep: 9,
      suffixes: [".tar.zst", ".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const urls = fetchMock.mock.calls.map((c) => {
      const [url] = c.arguments;
      assertString(url, "fetch URL arg");
      return url;
    });
    // Index 5 must have been probed (both entries) and then loop must stop.
    const index5Urls = urls.filter((u) => /\/5\.tar(\.|$)/.test(u));
    strictEqual(
      index5Urls.length,
      2,
      `expected both chain entries probed for index 5; got ${JSON.stringify(index5Urls)}`,
    );
    // No request for index 6 or later.
    const index6PlusUrls = urls.filter((u) => /\/[6-9]\.tar(\.|$)/.test(u));
    strictEqual(
      index6PlusUrls.length,
      0,
      `should not request index 6+; got ${JSON.stringify(index6PlusUrls)}`,
    );
  });

  it("produces the same request URL whether or not cdnUrl has a trailing slash", async () => {
    const dummyBytes = new Uint8Array([1, 2, 3]);
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(dummyBytes));

    const distDir = join(tmpDir, "dist");

    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/archives",
      distDir,
      archiveDir: "archives-no-slash",
      keep: 1,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/archives/",
      distDir,
      archiveDir: "archives-with-slash",
      keep: 1,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const urls = fetchMock.mock.calls.map((c) => {
      const [url] = c.arguments;
      assertString(url, "fetch URL arg");
      return url;
    });
    strictEqual(urls.length, 2, `expected exactly two requests; got ${JSON.stringify(urls)}`);
    strictEqual(urls[0], "https://cdn.example.com/archives/0.tar.gz");
    strictEqual(urls[1], "https://cdn.example.com/archives/0.tar.gz");
  });

  it("throws immediately on 5xx and does not try later chain entries", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/0.tar.zst")) {
        return new Response(null, { status: 500, statusText: "Internal Server Error" });
      }
      return new Response(new Uint8Array([0]));
    });

    const distDir = join(tmpDir, "dist");
    let thrown = false;
    try {
      await fetchPreviousArchives({
        cdnUrl: "https://cdn.example.com/a",
        distDir,
        archiveDir: "archives",
        keep: 3,
        suffixes: [".tar.zst", ".tar.gz", ".tar"],
        timeoutMs: TEST_TIMEOUT_MS,
      });
    } catch (error) {
      thrown = true;
      if (!(error instanceof Error))
        throw new TypeError("expected Error instance", { cause: error });
      strictEqual(error.message.includes("500"), true, "error should mention status 500");
    }
    strictEqual(thrown, true, "should have thrown on 5xx");

    // Only the primary was requested for index 0; fallbacks must not be tried.
    const urls = fetchMock.mock.calls.map((c) => c.arguments[0]);
    strictEqual(
      urls.length,
      1,
      `expected exactly one request before throw; got ${JSON.stringify(urls)}`,
    );
    strictEqual(urls[0], "https://cdn.example.com/a/0.tar.zst");
  });

  it("throws immediately on network errors and does not try later chain entries", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/0.tar.zst")) {
        throw new TypeError("fetch failed");
      }
      return new Response(new Uint8Array([0]));
    });

    const distDir = join(tmpDir, "dist");
    let thrown = false;
    try {
      await fetchPreviousArchives({
        cdnUrl: "https://cdn.example.com/a",
        distDir,
        archiveDir: "archives",
        keep: 3,
        suffixes: [".tar.zst", ".tar.gz"],
        timeoutMs: TEST_TIMEOUT_MS,
      });
    } catch (error) {
      thrown = true;
      if (!(error instanceof Error))
        throw new TypeError("expected Error instance", { cause: error });
    }
    strictEqual(thrown, true, "should have thrown on network error");

    const urls = fetchMock.mock.calls.map((c) => c.arguments[0]);
    strictEqual(urls.length, 1, "fallback must not be tried on network error");
    strictEqual(urls[0], "https://cdn.example.com/a/0.tar.zst");
  });

  it("applies the configured per-attempt timeout to each individual chain entry", async () => {
    const fetchMock = mock.method(globalThis, "fetch", createAbortAwarePendingFetch());

    const distDir = join(tmpDir, "dist");
    await rejects(
      () =>
        fetchPreviousArchives({
          cdnUrl: "https://cdn.example.com/a",
          distDir,
          archiveDir: "deploy-echoes",
          keep: 1,
          suffixes: [".tar.gz"],
          timeoutMs: 50,
        }),
      { message: /^Failed to fetch archive 0/ },
    );
    strictEqual(
      fetchMock.mock.calls.length,
      1,
      "fetch should have been called exactly once before timing out",
    );
  });

  it("each suffix in the chain at one index gets its own per-attempt timeout budget (fetch-resource-bounds R1.S2)", async () => {
    const fetchMock = mock.method(globalThis, "fetch", (url: string) => {
      if (url.endsWith(".tar.gz")) {
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 404, statusText: "Not Found" })),
            25,
          );
        });
      }
      if (url.endsWith(".tar.zst")) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(new Uint8Array([1, 2, 3]))), 10);
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "deploy-echoes",
      keep: 1,
      suffixes: [".tar.gz", ".tar.zst"],
      timeoutMs: 30,
    });

    strictEqual(
      fetchMock.mock.calls.length,
      2,
      "expected exactly two fetches (one per suffix at index 0)",
    );
    const url0 = fetchMock.mock.calls[0]?.arguments[0];
    const url1 = fetchMock.mock.calls[1]?.arguments[0];
    assertString(url0, "first call URL");
    assertString(url1, "second call URL");
    strictEqual(url0, "https://cdn.example.com/a/0.tar.gz");
    strictEqual(url1, "https://cdn.example.com/a/0.tar.zst");

    await stat(join(distDir, "deploy-echoes", "1.tar.zst"));
    await rejects(() => stat(join(distDir, "deploy-echoes", "1.tar.gz")), { code: "ENOENT" });
  });

  it("emits 'fetched <localName>' per successful save and 'no more archives on cdn' when the loop breaks on a gap", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      const match = /\/(\d+)\.tar\.gz$/.exec(url);
      if (!match) return new Response(null, { status: 404 });
      const idx = Number.parseInt(match[1]!, 10);
      if (idx <= 1) return new Response(new Uint8Array([idx]));
      return new Response(null, { status: 404, statusText: "Not Found" });
    });
    const errMock = mock.method(console, "error", () => {});

    await fetchPreviousArchives({
      cdnUrl: "https://example.com",
      distDir: tmpDir,
      archiveDir: "deploy-echoes",
      keep: 5,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const messages = errMock.mock.calls.map((c) => c.arguments[0]);
    strictEqual(
      JSON.stringify(messages),
      JSON.stringify(["fetched 1.tar.gz", "fetched 2.tar.gz", "no more archives on cdn"]),
      `expected exact stderr sequence; got: ${JSON.stringify(messages)}`,
    );
  });

  it("does not emit 'no more archives on cdn' when keep is fully consumed without a gap", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      const match = /\/(\d+)\.tar\.gz$/.exec(url);
      if (!match) return new Response(null, { status: 404 });
      const idx = Number.parseInt(match[1]!, 10);
      if (idx <= 2) return new Response(new Uint8Array([idx]));
      return new Response(null, { status: 404, statusText: "Not Found" });
    });
    const errMock = mock.method(console, "error", () => {});

    await fetchPreviousArchives({
      cdnUrl: "https://example.com",
      distDir: tmpDir,
      archiveDir: "deploy-echoes",
      keep: 3,
      suffixes: [".tar.gz"],
      timeoutMs: TEST_TIMEOUT_MS,
    });

    const messages = errMock.mock.calls.map((c) => c.arguments[0]);
    strictEqual(
      messages.includes("no more archives on cdn"),
      false,
      `should not emit gap line when keep is fully consumed; got: ${JSON.stringify(messages)}`,
    );
    strictEqual(
      messages.includes("fetched 1.tar.gz"),
      true,
      `expected fetched 1.tar.gz; got: ${JSON.stringify(messages)}`,
    );
    strictEqual(
      messages.includes("fetched 2.tar.gz"),
      true,
      `expected fetched 2.tar.gz; got: ${JSON.stringify(messages)}`,
    );
    strictEqual(
      messages.includes("fetched 3.tar.gz"),
      true,
      `expected fetched 3.tar.gz; got: ${JSON.stringify(messages)}`,
    );
  });

  it("with timeoutMs: 0, attaches no AbortSignal and does not abort a slow fetch", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      (_url: string, _init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolveFetch) => {
          setTimeout(() => resolveFetch(new Response(new Uint8Array([7, 8, 9]))), 100);
        }),
    );

    const distDir = join(tmpDir, "dist");
    await fetchPreviousArchives({
      cdnUrl: "https://cdn.example.com/a",
      distDir,
      archiveDir: "deploy-echoes",
      keep: 1,
      suffixes: [".tar.gz"],
      timeoutMs: 0,
    });

    strictEqual(fetchMock.mock.calls.length, 1, "fetch should have been called exactly once");
    const init = fetchMock.mock.calls[0]?.arguments[1];
    strictEqual(
      init?.signal,
      undefined,
      "expected init.signal to be undefined when timeoutMs is 0",
    );
  });
});
