// Compounding local corpus: every page qany reads is stored in a bounded
// JSONL store and searched with hand-rolled BM25, so qany keeps learning on
// your own machine — a private index no hosted engine can mirror.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./cache";
import type { SearchResult } from "./types";
import { splitPassages } from "./passages";

export interface CorpusDoc {
  url: string;
  title: string;
  text: string;
}

export interface CorpusDeps {
  dir?: string;
  maxDocs?: number;
}

const CORPUS_FILE = "corpus.jsonl";
const DEFAULT_MAX_DOCS = 600;
const MIN_TEXT_CHARS = 200;
const K1 = 1.5;
const B = 0.75;
const MAX_SNIPPET_CHARS = 180;

function corpusPath(deps: CorpusDeps): string {
  return join(deps.dir ?? cacheDir(), CORPUS_FILE);
}

function readDocs(path: string): CorpusDoc[] {
  if (!existsSync(path)) return [];
  const docs: CorpusDoc[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CorpusDoc>;
      if (
        typeof parsed.url === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.text === "string"
      ) {
        docs.push({ url: parsed.url, title: parsed.title, text: parsed.text });
      }
    } catch {
      // A torn trailing write leaves a partial line; skip it rather than
      // poisoning the whole index.
    }
  }
  return docs;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && token.length <= 20);
}

function bestSnippet(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  let best = 0;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at !== -1) best = Math.max(best, at);
  }
  const start = best > 40 ? best - 40 : 0;
  return text
    .slice(start, start + MAX_SNIPPET_CHARS)
    .replace(/\s+/g, " ")
    .trim();
}

// BM25 over the stored docs, scored per PASSAGE: each doc contributes its
// best window, so a dense answering paragraph outranks a long page where
// the query words only scatter. k1/b are the standard Okapi defaults.
function rank(docs: CorpusDoc[], query: string): SearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 || docs.length === 0) return [];
  type Post = { doc: CorpusDoc; tokens: string[]; passage: string };
  const posts: Post[] = [];
  for (const doc of docs) {
    const passages = splitPassages(doc.text);
    for (const passage of passages.length > 0 ? passages : [doc.text]) {
      posts.push({
        doc,
        tokens: tokenize(`${doc.title} ${doc.title} ${passage}`),
        passage,
      });
    }
  }
  const avgLen =
    posts.reduce((sum, post) => sum + post.tokens.length, 0) / posts.length;
  const docFreq = new Map<string, number>();
  for (const post of posts) {
    for (const token of new Set(post.tokens))
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const best = new Map<
    string,
    { doc: CorpusDoc; score: number; passage: string }
  >();
  for (const post of posts) {
    const termFreq = new Map<string, number>();
    for (const token of post.tokens)
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of tokens) {
      const tf = termFreq.get(token);
      if (!tf) continue;
      const df = docFreq.get(token) ?? 0;
      const idf = Math.log((posts.length - df + 0.5) / (df + 0.5) + 1);
      score +=
        idf *
        ((tf * (K1 + 1)) /
          (tf + K1 * (1 - B + B * (post.tokens.length / avgLen))));
    }
    if (score <= 0) continue;
    const current = best.get(post.doc.url);
    if (!current || score > current.score)
      best.set(post.doc.url, { doc: post.doc, score, passage: post.passage });
  }
  const scored = [...best.values()];
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(({ doc, passage }) => ({
    title: doc.title,
    url: doc.url,
    snippet: bestSnippet(passage, tokens),
    engine: "corpus",
  }));
}

// Words too common or too structural to identify a page. Ranks discriminative
// terms for query-by-example; keeps the list small and boring on purpose.
const QBE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "man",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "its",
  "let",
  "she",
  "too",
  "use",
  "when",
  "what",
  "why",
  "with",
  "this",
  "that",
  "from",
  "they",
  "them",
  "there",
  "here",
  "have",
  "been",
  "will",
  "your",
  "into",
  "than",
  "then",
  "more",
  "also",
  "just",
  "like",
  "over",
  "after",
  "before",
  "about",
  "which",
  "while",
  "under",
  "between",
  "other",
  "some",
]);

// Query-by-example: rank the page's words by tf * idf against the local
// corpus. Words the corpus sees everywhere (already-studied territory) score
// low; the page's novel content words score high. Returns a keyword query.
export function discriminativeQuery(
  text: string,
  deps: CorpusDeps = {},
): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "";
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const docs = loadDocs(corpusPath(deps));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(tokenize(doc.text)))
      df.set(token, (df.get(token) ?? 0) + 1);
  }
  const scored: { token: string; score: number }[] = [];
  for (const [token, tfv] of tf) {
    if (QBE_STOPWORDS.has(token)) continue;
    const dfv = df.get(token) ?? 0;
    const idf = Math.log((docs.length - dfv + 0.5) / (dfv + 0.5) + 1);
    scored.push({ token, score: tfv * idf });
  }
  scored.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.token < b.token ? -1 : 1,
  );
  return scored
    .slice(0, 5)
    .map((entry) => entry.token)
    .join(" ");
}

// The parsed index is memoized per (path, size, mtime) so repeated searches
// within one process skip re-reading a couple MB of JSONL.
let memoPath = "";
let memoStamp = "";
let memoDocs: CorpusDoc[] = [];

function loadDocs(path: string): CorpusDoc[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  if (path === memoPath && stamp === memoStamp) return memoDocs;
  memoPath = path;
  memoStamp = stamp;
  memoDocs = readDocs(path);
  return memoDocs;
}

export function corpusAdd(page: CorpusDoc, deps: CorpusDeps = {}): void {
  if (!page.url || !page.title || page.text.length < MIN_TEXT_CHARS) return;
  const path = corpusPath(deps);
  const maxDocs = deps.maxDocs ?? DEFAULT_MAX_DOCS;
  const docs = readDocs(path).filter((doc) => doc.url !== page.url);
  docs.push({ url: page.url, title: page.title, text: page.text });
  const kept = docs.slice(-maxDocs);
  const body = kept.map((doc) => JSON.stringify(doc)).join("\n") + "\n";
  writeFileSync(path, body);
  // Invalidate the memo so the next search sees the new doc set.
  if (path === memoPath) memoStamp = "";
}

export function corpusSearch(
  query: string,
  deps: CorpusDeps = {},
): SearchResult[] {
  const docs = loadDocs(corpusPath(deps));
  return rank(docs, query);
}
