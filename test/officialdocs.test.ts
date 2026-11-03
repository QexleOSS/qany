import { describe, expect, test } from "bun:test";
import { officialDocHosts, isOfficialDocPage } from "../src/officialdocs";
import {
  devTailFilter,
  promoteOfficialDocs,
  survivesDevRelevance,
} from "../src/search";
import type { SearchResult } from "../src/types";

function hit(url: string, title = url): SearchResult {
  return { title, url, snippet: "", engine: "test" };
}

const TS_RELEASE =
  "https://typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html";
const TS_NARROWING =
  "https://typescriptlang.org/docs/handbook/2/narrowing.html";
const SO_ANSWER =
  "https://stackoverflow.com/questions/11111111/typescript-satisfies-operator";

describe("official documentation hosts", () => {
  test("a product name earns its own manual", () => {
    expect(officialDocHosts("typescript satisfies operator")).toEqual([
      "typescriptlang.org",
    ]);
    expect(officialDocHosts("postgres explain analyze")).toEqual([
      "postgresql.org",
    ]);
    expect(officialDocHosts("how do I bake bread")).toEqual([]);
  });

  test("a manual page counts, a blog post does not", () => {
    expect(isOfficialDocPage("typescript satisfies operator", TS_RELEASE)).toBe(
      true,
    );
    expect(
      isOfficialDocPage("typescript satisfies operator", TS_NARROWING),
    ).toBe(true);
    expect(
      isOfficialDocPage(
        "typescript satisfies operator",
        "https://typescriptlang.org/blog/announcing-typescript-4-9",
      ),
    ).toBe(false);
  });

  test("a host without a product in the query is not a manual", () => {
    expect(isOfficialDocPage("typescript satisfies operator", SO_ANSWER)).toBe(
      false,
    );
    expect(isOfficialDocPage("how do I bake bread", TS_RELEASE)).toBe(false);
    expect(
      isOfficialDocPage("typescript satisfies operator", "not a url"),
    ).toBe(false);
  });
});

describe("dev tail gate", () => {
  test("the manual fails the title and URL guess on its own", () => {
    expect(
      survivesDevRelevance(
        "typescript satisfies operator",
        hit(TS_RELEASE, "Release notes TypeScript 4.9"),
      ),
    ).toBe(false);
  });

  test("a page that was read and evidenced the query stays", () => {
    const ordered = [
      hit(SO_ANSWER, "TypeScript satisfies operator"),
      hit(TS_RELEASE, "Release notes TypeScript 4.9"),
    ];
    const verified = new Set([SO_ANSWER]);
    const kept = devTailFilter(
      "typescript satisfies operator",
      ordered,
      verified,
    );
    expect(kept.map((result) => result.url)).toEqual([SO_ANSWER]);
  });

  test("a page nobody read needs the query in its title or URL", () => {
    const ordered = [
      hit(SO_ANSWER, "TypeScript satisfies operator"),
      hit(TS_RELEASE, "Release notes TypeScript 4.9"),
    ];
    const kept = devTailFilter(
      "typescript satisfies operator",
      ordered,
      new Set(),
    );
    expect(kept.map((result) => result.url)).toEqual([SO_ANSWER]);
  });

  test("a thin result set is never filtered to nothing", () => {
    const ordered = [hit(TS_RELEASE, "Release notes TypeScript 4.9")];
    const kept = devTailFilter(
      "typescript satisfies operator",
      ordered,
      new Set(),
    );
    expect(kept).toHaveLength(1);
  });
});

describe("manual promotion", () => {
  test("the manual enters the verification window", () => {
    const fused = [
      hit("https://stackoverflow.com/questions/1/a"),
      hit("https://stackoverflow.com/questions/2/b"),
      hit("https://stackoverflow.com/questions/3/c"),
      hit("https://stackoverflow.com/questions/4/d"),
      hit("https://stackoverflow.com/questions/5/e"),
      hit("https://stackoverflow.com/questions/6/f"),
      hit("https://stackoverflow.com/questions/7/g"),
      hit(TS_RELEASE, "Release notes TypeScript 4.9"),
      hit(TS_NARROWING, "Narrowing"),
    ];
    const promoted = promoteOfficialDocs(
      "typescript satisfies operator",
      fused,
    );
    const window = promoted.slice(0, 6).map((result) => result.url);
    expect(window).toContain(TS_RELEASE);
    expect(window).toContain(TS_NARROWING);
    expect(promoted).toHaveLength(fused.length);
  });

  test("at most two manuals are promoted", () => {
    const fused = [
      hit("https://stackoverflow.com/questions/1/a"),
      hit("https://stackoverflow.com/questions/2/b"),
      hit("https://stackoverflow.com/questions/3/c"),
      hit("https://stackoverflow.com/questions/4/d"),
      hit("https://stackoverflow.com/questions/5/e"),
      hit("https://stackoverflow.com/questions/6/f"),
      hit(TS_RELEASE, "Release notes TypeScript 4.9"),
      hit(TS_NARROWING, "Narrowing"),
      hit(
        "https://typescriptlang.org/docs/handbook/intro.html",
        "Introduction",
      ),
    ];
    const promoted = promoteOfficialDocs(
      "typescript satisfies operator",
      fused,
    );
    const window = promoted.slice(0, 6).map((result) => result.url);
    expect(
      window.filter((url) => url.includes("typescriptlang.org")),
    ).toHaveLength(2);
    expect(promoted).toHaveLength(fused.length);
  });

  test("a query without a product leaves the order alone", () => {
    const fused = [
      hit(SO_ANSWER, "TypeScript satisfies operator"),
      hit("https://example.com/a"),
    ];
    expect(promoteOfficialDocs("how do I bake bread", fused)).toEqual(fused);
  });
});
