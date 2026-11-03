// Domain trust learning: the content reranker already judges which pages
// actually answer a query. Each verdict is recorded per domain, and the
// accumulated pass ratio becomes a ranking tie-breaker in future fusions.
// Tiny, local, and self-correcting: sources that keep verifying float up,
// sources that keep failing drift down, all on this machine only.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./cache";

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Not a URL we can parse; its own string is the best domain key available.
    return url;
  }
}

function trustPath(deps: { dir?: string }): string {
  return join(deps.dir ?? cacheDir(), "trust.jsonl");
}

// Below this many verdicts a domain sits at the neutral 0.5: one lucky pass
// must not outrank sources with a real track record.
const MIN_SAMPLES = 3;
const MAX_LINES = 2_000;

export function recordVerdict(
  domain: string,
  passed: boolean,
  deps: { dir?: string } = {},
): void {
  if (domain === "") return;
  try {
    appendFileSync(
      trustPath(deps),
      `${JSON.stringify({ d: domain, p: passed ? 1 : 0 })}\n`,
    );
  } catch {
    // Trust learning is a bonus path; an unwritable cache dir must not fail
    // the search that triggered the verdict.
  }
}

export function loadTrust(deps: { dir?: string } = {}): Map<string, number> {
  const path = trustPath(deps);
  if (!existsSync(path)) return new Map();
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return new Map();
  }
  const stats = new Map<string, { pass: number; total: number }>();
  for (const line of lines.slice(-MAX_LINES)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as { d?: unknown; p?: unknown };
    if (typeof entry.d !== "string" || (entry.p !== 0 && entry.p !== 1))
      continue;
    const stat = stats.get(entry.d) ?? { pass: 0, total: 0 };
    stat.total += 1;
    stat.pass += entry.p;
    stats.set(entry.d, stat);
  }
  const scores = new Map<string, number>();
  for (const [domain, stat] of stats) {
    scores.set(
      domain,
      stat.total >= MIN_SAMPLES ? stat.pass / stat.total : 0.5,
    );
  }
  return scores;
}
