// Persistent engine cooldowns: a challenge in one CLI run must not be
// re-triggered by the next run. Every run is a fresh process, and hammering an
// endpoint that just challenged us keeps it blocked; the state lives next to
// the cache so every run sees it and the endpoint gets room to recover.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_MS = 600_000; // 10 minutes
const ESCALATED_MS = 1_800_000; // 30 minutes when challenged again soon
const RESET_MS = 1_800_000; // a quiet window this long starts over at the base

interface Entry {
  until: number;
  at: number;
}

function dirFor(override?: string): string {
  return (
    override ?? process.env.QANY_CACHE_DIR ?? join(homedir(), ".cache", "qany")
  );
}

function load(dir: string): Record<string, Entry> {
  try {
    return JSON.parse(
      readFileSync(join(dir, "cooldowns.json"), "utf8"),
    ) as Record<string, Entry>;
  } catch {
    // Missing or corrupt state means no cooldowns; the search proceeds.
    return {};
  }
}

export function cooldownRemainingMs(
  name: string,
  now: number,
  dir?: string,
): number {
  const entry = load(dirFor(dir))[name];
  if (entry === undefined) return 0;
  return Math.max(0, entry.until - now);
}

// Records a challenge and returns the cooldown duration in milliseconds:
// the base window normally, the escalated one when the engine was challenged
// again within the reset window.
export function recordChallenge(
  name: string,
  now: number,
  dir?: string,
): number {
  const resolved = dirFor(dir);
  const entries = load(resolved);
  const previous = entries[name];
  const escalated = previous !== undefined && now - previous.at < RESET_MS;
  const duration = escalated ? ESCALATED_MS : BASE_MS;
  entries[name] = { until: now + duration, at: now };
  try {
    mkdirSync(resolved, { recursive: true });
    writeFileSync(join(resolved, "cooldowns.json"), JSON.stringify(entries));
  } catch (error) {
    console.error(
      `qany: could not persist cooldowns in ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return duration;
}
