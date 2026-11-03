import { describe, expect, test } from "bun:test";
import { dateSignal, freshnessBoost } from "../src/fresh";
import type { SearchResult } from "../src/types";

// Bench day: 2026-10-20. Keeps buckets deterministic.
const NOW = new Date("2026-10-20T12:00:00Z");

function res(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "",
    url: "https://example.com/x",
    snippet: "",
    engine: "test",
    ...overrides,
  };
}

function boost(overrides: Partial<SearchResult> = {}): number {
  return freshnessBoost(res(overrides), NOW);
}

describe("dateSignal", () => {
  test("parses Month D, YYYY in the title", () => {
    const signal = dateSignal(
      "Bun v1.4.3 — October 10, 2026",
      "https://bun.sh/blog",
      "",
      NOW,
    )!;
    expect(signal.year).toBe(2026);
    // Oct 10 -> Oct 20 is 10 days.
    expect(signal.ageDays).toBeCloseTo(10 + 0.5, 4);
  });

  test("parses D Month YYYY", () => {
    const signal = dateSignal("", "", "released 5 October 2026 today", NOW)!;
    expect(signal.ageDays).toBeCloseTo(15 + 0.5, 4);
  });

  test("parses ISO and ISO datetime in snippets", () => {
    const signal = dateSignal("", "", "published 2026-10-10T14:00Z", NOW)!;
    expect(signal.year).toBe(2026);
    expect(signal.ageDays).toBeCloseTo(10 + 0.5, 4);
  });

  test("parses URL path dates", () => {
    const signal = dateSignal(
      "",
      "https://news.example/2026/10/18/story",
      "",
      NOW,
    )!;
    expect(signal.ageDays).toBeCloseTo(2 + 0.5, 4);
  });

  test("parses relative phrases", () => {
    const signal = dateSignal("", "", "updated 3 hours ago", NOW)!;
    expect(signal.year).toBeNull();
    expect(signal.ageDays).toBeCloseTo(3 / 24, 4);
  });

  test("prefers the freshest signal when title is stale and snippet is fresh", () => {
    const signal = dateSignal(
      "Launched March 2025 edition",
      "https://example.com/x",
      "updated 2 days ago",
      NOW,
    )!;
    expect(signal.year).toBeNull();
    expect(signal.ageDays).toBe(2);
  });

  test("returns null for a bare year and for invalid calendar dates", () => {
    expect(
      dateSignal(
        "Nobel Prize 2026 ceremony recap",
        "https://example.com/x",
        "",
        NOW,
      ),
    ).toBeNull();
    expect(
      dateSignal(
        "Wrong date February 30, 2026",
        "https://example.com/x",
        "",
        NOW,
      ),
    ).toBeNull();
  });

  test("keeps half-month midpoints for partial URL dates", () => {
    const signal = dateSignal(
      "",
      "https://news.example/2026/08/roundup",
      "",
      NOW,
    )!;
    // Aug 15 midpoint -> Oct 20 is about 66 days.
    expect(signal.ageDays).toBeGreaterThan(60);
    expect(signal.ageDays).toBeLessThan(70);
  });
});

describe("freshnessBoost", () => {
  test("hours-old earns the strongest nudge", () => {
    expect(boost({ snippet: "posted 6 hours ago" })).toBe(0.006);
  });

  test("recent explicit dates earn +0.004", () => {
    expect(boost({ title: "Node.js 24.22.0 released October 14, 2026" })).toBe(
      0.004,
    );
  });

  test("quarter-old dates earn +0.002", () => {
    expect(boost({ title: "Guide updated 10 August 2026" })).toBe(0.002);
  });

  test("this-year dates 90-400 days old stay neutral", () => {
    expect(boost({ title: "A look back at February 20, 2026" })).toBe(0);
  });

  test("last-year timestamps get the stale malus", () => {
    expect(boost({ title: "December 2025 year in review" })).toBe(-0.002);
    expect(boost({ url: "https://news.example/2019/03/12/old-news" })).toBe(
      -0.002,
    );
  });

  test("a fresher relative signal overrides the last-year malus", () => {
    expect(
      boost({
        title: "IPO March 2025 filings",
        snippet: "edited 2 days ago",
      }),
    ).toBe(0.004);
  });

  test("undated results stay at zero", () => {
    expect(boost()).toBe(0);
    expect(
      boost({ url: "https://example.com/releases/v2026.10/issues/4221" }),
    ).toBe(0);
  });
});
