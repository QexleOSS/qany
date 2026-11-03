import type { FetchedPage, SearchResult } from "./types";

const SNIPPET_MAX = 200;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function formatResultsText(
  results: SearchResult[],
  query: string,
): string {
  if (results.length === 0) {
    return `No results for: ${query}`;
  }
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${collapse(r.title)}`, `   ${r.url}`];
      const snippet = collapse(r.snippet).slice(0, SNIPPET_MAX);
      if (snippet !== "") {
        lines.push(`   ${snippet}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export function formatResultsJson(
  results: SearchResult[],
  _query: string,
): string {
  return JSON.stringify(results);
}

export function formatPageText(page: FetchedPage): string {
  const marker = page.truncated
    ? `\n\n[truncated at ${page.text.length} chars]`
    : "";
  return `# ${collapse(page.title)}\n${page.url} (${page.via})\n\n${page.text}${marker}`;
}

export function formatPageJson(page: FetchedPage): string {
  return JSON.stringify(page);
}
