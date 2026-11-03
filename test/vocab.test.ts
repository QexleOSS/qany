import { describe, expect, test } from "bun:test";
import { aliasTokens, sharesVocabulary } from "../src/vocab";

describe("aliasTokens", () => {
  test("expands abbreviations to their full vocabulary", () => {
    expect(aliasTokens(["js", "iterators"])).toEqual(["javascript"]);
    expect(aliasTokens(["gc", "tuning"])).toEqual(["garbage", "collection"]);
    expect(aliasTokens(["k8s", "deploy"])).toEqual(["kubernetes"]);
  });

  test("adds the throttling counterpart of rate limiting", () => {
    expect(aliasTokens(["rate", "limiting", "api"])).toEqual(["throttling"]);
  });

  test("skips tokens already present and caps additions", () => {
    expect(aliasTokens(["javascript", "js"])).toEqual([]);
    expect(aliasTokens(["caching", "memoization"])).toEqual([]);
    const many = aliasTokens(["js", "ts", "py", "k8s", "gc", "oauth"]);
    expect(many.length).toBeLessThanOrEqual(4);
  });

  test("returns [] for unknown tokens and preserves input order of adds", () => {
    expect(aliasTokens(["frobnicate"])).toEqual([]);
    expect(aliasTokens(["oauth", "js"])).toEqual([
      "authentication",
      "javascript",
    ]);
  });

  test("ignores case", () => {
    expect(aliasTokens(["JS"])).toEqual(["javascript"]);
  });
});

describe("sharesVocabulary", () => {
  test("rejects a trending phrase that only borrows the year", () => {
    expect(
      sharesVocabulary(
        "latest stable Bun release October 2026",
        "fastelavn bun run 2026",
      ),
    ).toBe(false);
  });

  test("accepts a single-typo spelling fix on the query's subject", () => {
    expect(sharesVocabulary("throtling api", "throttling api")).toBe(true);
  });

  test("accepts a wordbreak fix and clear near-words", () => {
    expect(sharesVocabulary("bun htmlrewriter", "bun html rewriter")).toBe(
      true,
    );
    expect(
      sharesVocabulary("react throtling guide", "react throttling guide"),
    ).toBe(true);
  });

  test("rejects an unrelated suggestion and a lone short shared token", () => {
    expect(
      sharesVocabulary("api throttling guide", "weather forecast paris"),
    ).toBe(false);
    expect(sharesVocabulary("latest news", "run 2026 mini marathon")).toBe(
      false,
    );
  });

  test("punts when the query has no content tokens", () => {
    expect(sharesVocabulary("bun", "bun run fastelavn")).toBe(true);
  });
});
