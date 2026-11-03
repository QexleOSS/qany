import { describe, expect, test } from "bun:test";
import {
  formatPageJson,
  formatPageText,
  formatResultsJson,
  formatResultsText,
} from "../src/format";
import type { FetchedPage, SearchResult } from "../src/types";

const results: SearchResult[] = [
  {
    title: "Bun Docs",
    url: "https://bun.com/docs",
    snippet: "Fast all-in-one runtime",
    engine: "ddg",
  },
  {
    title: "Bun Blog",
    url: "https://bun.com/blog",
    snippet: "Release notes",
    engine: "bing",
  },
];

describe("formatResultsText", () => {
  test("renders numbered blocks with indented url and snippet", () => {
    expect(formatResultsText(results, "bun")).toBe(
      "1. Bun Docs\n   https://bun.com/docs\n   Fast all-in-one runtime\n2. Bun Blog\n   https://bun.com/blog\n   Release notes",
    );
  });

  test("caps snippets at 200 chars", () => {
    const out = formatResultsText(
      [
        {
          title: "T",
          url: "https://t.example",
          snippet: "x".repeat(250),
          engine: "test",
        },
      ],
      "t",
    );
    expect(out).toBe(`1. T\n   https://t.example\n   ${"x".repeat(200)}`);
  });

  test("collapses whitespace in title and snippet", () => {
    const out = formatResultsText(
      [
        {
          title: "A\nTitle",
          url: "https://t.example",
          snippet: "one\ntwo   three",
          engine: "test",
        },
      ],
      "t",
    );
    expect(out).toBe("1. A Title\n   https://t.example\n   one two three");
  });

  test("omits the snippet line when the snippet is empty", () => {
    const out = formatResultsText(
      [{ title: "T", url: "https://t.example", snippet: "", engine: "test" }],
      "t",
    );
    expect(out).toBe("1. T\n   https://t.example");
  });

  test("reports no results", () => {
    expect(formatResultsText([], "nope")).toBe("No results for: nope");
  });
});

describe("formatResultsJson", () => {
  test("emits single-line JSON that round-trips", () => {
    const out = formatResultsJson(results, "bun");
    expect(out).not.toContain("\n");
    expect(JSON.parse(out)).toEqual(results);
  });

  test("emits an empty array for no results", () => {
    expect(formatResultsJson([], "nope")).toBe("[]");
  });
});

describe("formatPageText", () => {
  test("renders header with title, url, via, then text", () => {
    const page: FetchedPage = {
      url: "https://example.com",
      title: "Example Domain",
      text: "Hello world.",
      via: "direct",
      truncated: false,
    };
    expect(formatPageText(page)).toBe(
      "# Example Domain\nhttps://example.com (direct)\n\nHello world.",
    );
  });

  test("marks truncated pages with the cap size", () => {
    const page: FetchedPage = {
      url: "https://example.com",
      title: "Example Domain",
      text: "x".repeat(20),
      via: "direct",
      truncated: true,
    };
    expect(formatPageText(page)).toBe(
      `# Example Domain\nhttps://example.com (direct)\n\n${"x".repeat(20)}\n\n[truncated at 20 chars]`,
    );
  });
});

describe("formatPageJson", () => {
  test("emits single-line JSON that round-trips", () => {
    const page: FetchedPage = {
      url: "https://example.com",
      title: "Example Domain",
      text: "Hello world.",
      via: "wayback",
      truncated: true,
    };
    const out = formatPageJson(page);
    expect(out).not.toContain("\n");
    expect(JSON.parse(out)).toEqual(page);
  });
});
