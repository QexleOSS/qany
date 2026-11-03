import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CacheDeps {
  dir?: string;
  now?: () => number;
  memoryMax?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const DEFAULT_MEMORY_MAX = 500;
const memory = new Map<string, CacheEntry>();

export function cacheDir(): string {
  const override = process.env.QANY_CACHE_DIR;
  if (override) {
    return override;
  }
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "qany");
}

function disabled(): boolean {
  return Boolean(process.env.QANY_NO_CACHE);
}

function memKey(dir: string, key: string): string {
  return `${dir}\u0000${key}`;
}

function fileFor(dir: string, key: string): string {
  return join(dir, createHash("sha256").update(key).digest("hex") + ".json");
}

function isEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.expiresAt === "number" && "value" in rec;
}

export async function cacheGet<T>(
  key: string,
  allowExpired = false,
  deps: CacheDeps = {},
): Promise<T | undefined> {
  if (disabled()) return undefined;
  const dir = deps.dir ?? cacheDir();
  const now = deps.now ?? Date.now;

  const mk = memKey(dir, key);
  const remembered = memory.get(mk);
  if (remembered) {
    if (allowExpired || remembered.expiresAt > now()) {
      // Refresh recency so eviction drops colder entries first.
      memory.delete(mk);
      memory.set(mk, remembered);
      return remembered.value as T;
    }
    memory.delete(mk);
  }

  const file = fileFor(dir, key);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `qany: cache read failed for ${key}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt entry: remove it so the next write starts clean.
    await rm(file, { force: true });
    return undefined;
  }

  if (!isEntry(parsed)) {
    await rm(file, { force: true });
    return undefined;
  }
  if (!allowExpired && parsed.expiresAt <= now()) {
    await rm(file, { force: true });
    return undefined;
  }
  memory.set(mk, parsed);
  return parsed.value as T;
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
  deps: CacheDeps = {},
): Promise<void> {
  if (disabled()) return;
  const dir = deps.dir ?? cacheDir();
  const now = deps.now ?? Date.now;
  const entry: CacheEntry = { expiresAt: now() + ttlMs, value };
  memory.set(memKey(dir, key), entry);
  const cap = deps.memoryMax ?? DEFAULT_MEMORY_MAX;
  while (memory.size > cap) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(fileFor(dir, key), JSON.stringify(entry), "utf8");
  } catch (err) {
    // Cache writes are best-effort; a failed write must not fail the request.
    console.error(
      `qany: cache write failed for ${key}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
