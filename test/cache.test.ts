import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheGet, cacheSet, type CacheDeps } from "../src/cache";

class FakeClock {
  t = 1_000_000;
  now = () => this.t;
}

function freshDeps(): { deps: CacheDeps; clock: FakeClock; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "qany-cache-"));
  const clock = new FakeClock();
  return { deps: { dir, now: clock.now }, clock, dir };
}

function fileFor(dir: string, key: string): string {
  return join(dir, createHash("sha256").update(key).digest("hex") + ".json");
}

describe("cache", () => {
  test("roundtrips a value", async () => {
    const { deps, dir } = freshDeps();
    await cacheSet("key-a", { a: 1 }, 60_000, deps);
    expect(await cacheGet("key-a", false, deps)).toEqual({ a: 1 });
    expect(existsSync(fileFor(dir, "key-a"))).toBe(true);
  });

  test("expires values after their ttl", async () => {
    const { deps, clock } = freshDeps();
    await cacheSet("key-b", "value", 1_000, deps);
    clock.t += 2_000;
    expect(await cacheGet("key-b", false, deps)).toBeUndefined();
  });

  test("returns expired values when allowExpired is set", async () => {
    const { deps, clock } = freshDeps();
    await cacheSet("key-c", "stale", 1_000, deps);
    clock.t += 2_000;
    expect(await cacheGet("key-c", true, deps)).toBe("stale");
  });

  test("treats corrupt files as a miss and removes them", async () => {
    const { deps, dir } = freshDeps();
    const file = fileFor(dir, "key-d");
    writeFileSync(file, "{not json");
    expect(await cacheGet("key-d", false, deps)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("keeps distinct keys isolated", async () => {
    const { deps } = freshDeps();
    await cacheSet("key-e", 1, 60_000, deps);
    await cacheSet("key-f", 2, 60_000, deps);
    expect(await cacheGet("key-e", false, deps)).toBe(1);
    expect(await cacheGet("key-f", false, deps)).toBe(2);
  });

  test("serves from memory after the file is gone", async () => {
    const { deps, dir } = freshDeps();
    await cacheSet("key-g", "warm", 60_000, deps);
    rmSync(fileFor(dir, "key-g"));
    expect(await cacheGet("key-g", false, deps)).toBe("warm");
  });

  test("evicts the least recently used memory entries above the cap", async () => {
    const { deps, dir } = freshDeps();
    const capped: CacheDeps = { ...deps, memoryMax: 2 };
    await cacheSet("key-i", 1, 60_000, capped);
    await cacheSet("key-j", 2, 60_000, capped);
    // Touch key-i so key-j becomes the oldest entry.
    expect(await cacheGet("key-i", false, capped)).toBe(1);
    await cacheSet("key-k", 3, 60_000, capped);
    rmSync(fileFor(dir, "key-i"));
    rmSync(fileFor(dir, "key-j"));
    rmSync(fileFor(dir, "key-k"));
    expect(await cacheGet("key-i", false, capped)).toBe(1);
    expect(await cacheGet("key-j", false, capped)).toBeUndefined();
    expect(await cacheGet("key-k", false, capped)).toBe(3);
  });

  test("QANY_NO_CACHE disables both reads and writes", async () => {
    const { deps, dir } = freshDeps();
    process.env.QANY_NO_CACHE = "1";
    try {
      await cacheSet("key-h", "value", 60_000, deps);
      expect(existsSync(fileFor(dir, "key-h"))).toBe(false);
      expect(await cacheGet("key-h", false, deps)).toBeUndefined();
    } finally {
      delete process.env.QANY_NO_CACHE;
    }
  });

  test("QANY_CACHE_DIR overrides the cache location and beats XDG_CACHE_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qany-cache-env-"));
    process.env.QANY_CACHE_DIR = dir;
    process.env.XDG_CACHE_HOME = join(dir, "ignored");
    try {
      await cacheSet("key-env", "value", 60_000);
      expect(existsSync(fileFor(dir, "key-env"))).toBe(true);
      expect(await cacheGet("key-env")).toBe("value");
    } finally {
      delete process.env.QANY_CACHE_DIR;
      delete process.env.XDG_CACHE_HOME;
    }
  });
});
