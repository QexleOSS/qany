// Date freshness signals for ranking: the freshest explicit date found in a
// result's title, URL, or snippet nudges its fused score. Bare years count for
// nothing ("Nobel Prize 2026" says nothing about when the page was written);
// only resolvable calendar dates and relative phrases count as evidence.
import type { SearchResult } from "./types";

export interface DateSignal {
  /** Age of the date, in days; negative values are clamped later. */
  ageDays: number;
  /** Calendar year of the date, when it came from an explicit date form. */
  year: number | null;
}

const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const MONTH_GROUP = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
// "October 10, 2026" / "Oct 10 2026"
const MONTH_DAY_YEAR = new RegExp(
  String.raw`\b${MONTH_GROUP}\.?\s+(\d{1,2}),?\s+(\d{4})\b`,
  "gi",
);
// "10 October 2026"
const DAY_MONTH_YEAR = new RegExp(
  String.raw`\b(\d{1,2})\.?\s+${MONTH_GROUP}\.?,?\s+(\d{4})\b`,
  "gi",
);
// "December 2025" — month precision only; the day stays at the midpoint.
// Cannot match "October 10, 2026" because the year is never whitespace-adjacent.
const MONTH_YEAR = new RegExp(
  String.raw`\b${MONTH_GROUP}\.?,?\s+(\d{4})\b`,
  "gi",
);

function collect(
  text: string,
  regex: RegExp,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null)
    spans.push({ start: match.index, end: regex.lastIndex });
  return spans;
}

function overlaps(
  span: { start: number; end: number },
  spans: { start: number; end: number }[],
): boolean {
  return spans.some(
    (other) => span.start < other.end && other.start < span.end,
  );
}
// "2026-10-10" and "2026-10-10T14:00Z"
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?![\d])/g;
// "6 hours ago" / "3 weeks ago"
const RELATIVE = /\b(\d+)\s+(hours?|days?|weeks?|months?)\s+ago\b/gi;
// URL path dates: /2026/10/10/, /2026/10/, /2026-10/ (news-archive shapes).
const URL_DATE = /\/(\d{4})([/\-.](\d{2}))?([/\-.](\d{1,2}))?(?=\/|$|\.)/g;

function validAsciiDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function monthNumber(name: string): number | undefined {
  return MONTHS.get(name.slice(0, 3).toLowerCase());
}

function ageFromCalendar(
  year: number,
  month: number,
  day: number | null,
  now: Date,
): DateSignal | null {
  if (!validAsciiDay(year, month, day ?? 1)) return null;
  const moment = new Date(Date.UTC(year, month - 1, day ?? 15));
  // Half-month midpoints keep partial dates neutral instead of shouting "new".
  const ageDays = (now.getTime() - moment.getTime()) / 86_400_000;
  return { ageDays, year };
}

function ageFromRelative(count: number, unit: string): DateSignal | null {
  if (!Number.isFinite(count) || count < 0 || count > 100_000) return null;
  const days = unit.startsWith("hour")
    ? count / 24
    : unit.startsWith("day")
      ? count
      : unit.startsWith("week")
        ? count * 7
        : count * 30;
  return { ageDays: days, year: null };
}

function signalFromText(text: string, now: Date): DateSignal | null {
  let best: DateSignal | null = null;
  const consider = (signal: DateSignal | null): void => {
    if (signal && (best === null || signal.ageDays < best.ageDays))
      best = signal;
  };
  const preciseSpans = collect(text, MONTH_DAY_YEAR).concat(
    collect(text, DAY_MONTH_YEAR),
  );
  let match: RegExpExecArray | null;
  MONTH_DAY_YEAR.lastIndex = 0;
  while ((match = MONTH_DAY_YEAR.exec(text)) !== null) {
    const month = monthNumber(match[1]!);
    if (month === undefined) continue;
    consider(ageFromCalendar(Number(match[3]), month, Number(match[2]), now));
  }
  DAY_MONTH_YEAR.lastIndex = 0;
  while ((match = DAY_MONTH_YEAR.exec(text)) !== null) {
    const month = monthNumber(match[2]!);
    if (month === undefined) continue;
    consider(ageFromCalendar(Number(match[3]), month, Number(match[1]), now));
  }
  MONTH_YEAR.lastIndex = 0;
  while ((match = MONTH_YEAR.exec(text)) !== null) {
    if (
      overlaps({ start: match.index, end: MONTH_YEAR.lastIndex }, preciseSpans)
    )
      continue;
    const month = monthNumber(match[1]!);
    if (month === undefined) continue;
    consider(ageFromCalendar(Number(match[2]), month, null, now));
  }
  ISO_DATE.lastIndex = 0;
  while ((match = ISO_DATE.exec(text)) !== null) {
    consider(
      ageFromCalendar(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        now,
      ),
    );
  }
  RELATIVE.lastIndex = 0;
  while ((match = RELATIVE.exec(text)) !== null) {
    consider(ageFromRelative(Number(match[1]), match[2]!.toLowerCase()));
  }
  return best;
}

function signalFromUrl(url: string, now: Date): DateSignal | null {
  let best: DateSignal | null = null;
  let match: RegExpExecArray | null;
  URL_DATE.lastIndex = 0;
  while ((match = URL_DATE.exec(url)) !== null) {
    const year = Number(match[1]);
    const month = match[3] ? Number(match[3]) : null;
    const day = match[5] ? Number(match[5]) : null;
    if (month !== null && (month < 1 || month > 12)) continue;
    if (day !== null && (day < 1 || day > 31)) continue;
    // /YYYY/ slugs and fragment ids like #2026 stay out; two or more
    // components imply a publish-path shape.
    if (month === null) continue;
    const signal = ageFromCalendar(year, month, day ?? 15, now);
    if (signal && (best === null || signal.ageDays < best.ageDays))
      best = signal;
  }
  return best;
}

/** The freshest resolvable date across title, URL, and snippet; null if none. */
export function dateSignal(
  title: string,
  url: string,
  snippet: string,
  now: Date,
): DateSignal | null {
  const candidates = [
    signalFromText(title, now),
    signalFromUrl(url, now),
    signalFromText(snippet, now),
  ];
  let best: DateSignal | null = null;
  for (const signal of candidates) {
    if (signal && (best === null || signal.ageDays < best.ageDays))
      best = signal;
  }
  return best;
}

/**
 * Tie-scale nudge, same money as the trust bonus: each rank step within one
 * engine list is ~0.00026, so ±0.002 flips shallow locks but never consensus.
 */
export function freshnessBoost(result: SearchResult, now: Date): number {
  const signal = dateSignal(result.title, result.url, result.snippet, now);
  if (!signal) return 0;
  const age = Math.max(0, signal.ageDays);
  // A calendar date from a previous year is stale evidence on its own — the
  // page may be republished, but its own timestamp stays old — unless a
  // fresher signal (relative phrase, URL path date) outcarried it.
  if (signal.year !== null && signal.year < now.getUTCFullYear()) return -0.002;
  if (age < 1) return 0.006;
  if (age < 14) return 0.004;
  if (age < 90) return 0.002;
  if (age <= 400) return 0;
  return -0.002;
}
