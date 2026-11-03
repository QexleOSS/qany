export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  via: "direct" | "wayback" | "cache";
  truncated: boolean;
}

export interface SearchOptions {
  num?: number;
  engines?: Engine[];
  noCache?: boolean;
  /** Force on (or off) the content-verified rerank instead of its auto rule. */
  rerank?: boolean;
  /** Rerank page source; production default is fetchPage trimmed to 6k chars. */
  pageFetcher?: (url: string) => Promise<FetchedPage>;
  /** Include the local read-history corpus as a ranking vote (default true). */
  corpus?: boolean;
  /** Drop an engine whose top three results miss the query (default true). */
  guard?: boolean;
}

export interface PageOptions {
  maxChars?: number;
  noCache?: boolean;
}

export interface Engine {
  name: string;
  minIntervalMs: number;
  search(query: string, num: number): Promise<SearchResult[]>;
}
