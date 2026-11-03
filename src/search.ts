// Multi-engine search aggregation: query reformulation, rank fusion by RRF,
// relevance guard, content-verified rerank, cache with stale fallback.
import { cacheGet, cacheSet, type CacheDeps } from "./cache";
import { bestPassage } from "./passages";
import { corpusSearch } from "./corpus";
import {
  arxivEngine,
  bingEngine,
  braveEngine,
  ddgEngine,
  githubEngine,
  hnEngine,
  mdnEngine,
  mwmblEngine,
  newsEngine,
  npmEngine,
  openalexEngine,
  rightDaoEngine,
  stackoverflowEngine,
  suggestQuery,
  wikiEngine,
} from "./engines";
import { aliasTokens, sharesVocabulary } from "./vocab";
import { classifyIntent, engineWeight, isProductQuery } from "./intent";
import { isOfficialDocPage } from "./officialdocs";
import { domainOf, loadTrust, recordVerdict } from "./trust";
import { cooldownRemainingMs, recordChallenge } from "./cooldown";
import { freshnessBoost } from "./fresh";
import type { Engine, FetchedPage, SearchOptions, SearchResult } from "./types";
import { fetchPage } from "./fetch";
import { politeFetch } from "./http";
import { inflateSync } from "node:zlib";

const CACHE_TTL_MS = 600_000;
const EMPTY_TTL_MS = 180_000;
const DEFAULT_NUM = 8;
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|sref|ref_src)$/;

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL we can parse; use it verbatim as its own key.
    return raw;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const params = [...url.searchParams.entries()].filter(
    ([k]) => !TRACKING_PARAM.test(k.toLowerCase()),
  );
  params.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  const search =
    params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${path}${search}`;
}

const RRF_K = 60;
// No single engine may hold the whole search hostage. A dead or throttled
// endpoint is benched by its own cooldown logic, and the deadline keeps the
// caller from waiting on a socket that will never answer. The engines run in
// parallel, so this is the wait for the slowest one and nothing else. Six
// seconds is what a slow public endpoint needs to answer at all; the old two
// second deadline cut off the only engine that still replies from a throttled
// network.
const ENGINE_TIMEOUT_MS = 6_000;
// The blackout retry gets a longer deadline. A round where every engine timed
// out is usually a slow network rather than a dead endpoint, and a slow
// network answers a few seconds later. The retry re-asks with room to breathe
// before any engine gets benched.
const ENGINE_RETRY_TIMEOUT_MS = 12_000;
// Page evidence is useful only if it arrives in time to change the answer.
// A live page that hangs (or a 403 that triggers a slow Wayback fallback) must
// not stall the whole search behind one slow URL.
const PAGE_TIMEOUT_MS = 2_500;
// The expansion wave is a recall win, not a correctness requirement. If the
// first pass already spent the budget, return verified results instead of
// spending another two seconds on speculative queries.
const EXPANSION_BUDGET_MS = 2_800;

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Official-source bump: government, military, and academic domains win
// near-ties against press and community pages. Sized above the trust nudge
// (so a ministry page beats a newspaper with comparable support) and far
// below one full list vote (so it never overrides consensus).
const AUTHORITY_OFFICIAL = /\.(gov|mil)(\.[a-z]{2})?$/;
const AUTHORITY_ACADEMIC = /\.(edu|ac)(\.[a-z]{2})?$|\.int$/;
// Supranational institutions whose domains are official but not TLD-marked.
const AUTHORITY_INSTITUTIONS =
  /(^|\.)(europa\.eu|un\.org|fca\.org\.uk|ofcom\.org\.uk|ico\.org\.uk)$/;

// An official page only counts as "official sources already present" when it
// carries the query's most specific token; otherwise a generic country portal
// (india.gov.in "facts of India") suppresses the official-source request on
// every news query.
function carriesSpecificToken(query: string, result: SearchResult): boolean {
  const tokens = queryTokens(query).filter(
    (token) => !RERANK_FILLER.has(token),
  );
  if (tokens.length === 0) return true;
  let specific = tokens[0]!;
  for (const token of tokens) {
    if (token.length > specific.length) specific = token;
  }
  // Title and URL only: snippets are engine-generated and carry the query's
  // own words, so they cannot testify that the page covers the topic.
  const hay = `${result.title} ${result.url}`.toLowerCase();
  if (hay.includes(specific)) return true;
  return (hay.match(/[a-z0-9]+/g) ?? []).some(
    (word) => prefixLength(word, specific) >= 6,
  );
}

function authorityBonus(url: string): number {
  const host = domainOf(url);
  if (AUTHORITY_OFFICIAL.test(host) || AUTHORITY_INSTITUTIONS.test(host))
    return 0.002;
  if (AUTHORITY_ACADEMIC.test(host)) return 0.0012;
  return 0;
}

export function fuseResults(
  query: string,
  lists: SearchResult[][],
  trust?: Map<string, number>,
  weights?: number[],
  now?: Date,
): SearchResult[] {
  // Dedupe by normalized URL, keeping the first copy and filling gaps from later ones.
  const unique: SearchResult[] = [];
  const indexOf = new Map<string, number>();
  for (const list of lists) {
    for (const result of list) {
      const key = normalizeUrl(result.url);
      const existing = indexOf.get(key);
      if (existing === undefined) {
        indexOf.set(key, unique.length);
        unique.push({ ...result });
        continue;
      }
      const kept = unique[existing];
      if (!kept.snippet && result.snippet) kept.snippet = result.snippet;
      if (!kept.title && result.title) kept.title = result.title;
    }
  }

  // Query-word overlap acts as one more ranking vote (a virtual engine),
  // weighted by token rarity and gated on the rarest token.
  const relevance = poolRelevance(query, unique);
  const relevanceOrder = unique
    .map((_, index) => index)
    .sort((a, b) => relevance[b] - relevance[a] || a - b);

  // Reciprocal Rank Fusion over the real engines plus the virtual one; each
  // engine's votes scale by its intent weight, normalized so the average
  // stays 1: intent redistributes influence BETWEEN engines, it does not
  // inflate engine consensus against the relevance vote.
  const fused = unique.map(() => 0);
  const scale =
    weights && weights.length > 0
      ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length
      : 1;
  const divisor = scale > 0 ? scale : 1;
  lists.forEach((list, listIndex) => {
    const weight = (weights?.[listIndex] ?? 1) / divisor;
    list.forEach((result, position) => {
      const index = indexOf.get(normalizeUrl(result.url));
      if (index !== undefined) fused[index]! += weight / (RRF_K + position + 1);
    });
  });
  relevanceOrder.forEach((index, position) => {
    fused[index] += 1 / (RRF_K + position + 1);
  });

  const order = unique.map((_, index) => index);
  // Domain trust nudges the fused score by at most ±0.001 — enough to flip
  // shallow near-ties (each rank step within one list is ~0.00026; three of
  // them are ~0.0008), far below one real rank step (1/61 ≈ 0.016), so it
  // never overrides consensus.
  if (trust) {
    unique.forEach((result, index) => {
      fused[index]! += ((trust.get(domainOf(result.url)) ?? 0.5) - 0.5) * 0.002;
    });
  }
  unique.forEach((result, index) => {
    fused[index]! += authorityBonus(result.url);
    // Freshness rides the same tie-scale as trust, clamped to ±0.004 so an
    // hour-old date can flip near-ties but never one real rank step.
    fused[index]! += Math.max(
      -0.004,
      Math.min(0.004, freshnessBoost(result, now ?? new Date())),
    );
  });
  order.sort(
    (a, b) => fused[b] - fused[a] || relevance[b] - relevance[a] || a - b,
  );
  return order.map((index) => ({ ...unique[index] }));
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "were",
  "has",
  "have",
  "you",
  "your",
  "its",
  "our",
  "their",
  "about",
  "into",
  "over",
]);

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function tokenVariants(token: string): string[] {
  const variants = [token];
  if (token.length >= 4 && token.endsWith("s"))
    variants.push(token.slice(0, -1));
  return variants;
}

function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let index = hay.indexOf(needle);
  while (index !== -1 && count < 3) {
    count += 1;
    index = hay.indexOf(needle, index + needle.length);
  }
  return count;
}

function relevanceScore(
  query: string,
  result: SearchResult,
  weights?: number[],
): number {
  const tokens = queryTokens(query).map(tokenVariants);
  if (tokens.length === 0) return 0;
  const title = result.title.toLowerCase();
  const url = result.url.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  let score = 0;
  tokens.forEach((variants, i) => {
    const weight = weights?.[i] ?? 1;
    const field = (text: string, fieldWeight: number) =>
      fieldWeight *
      Math.max(
        0,
        ...variants.map((variant) => countOccurrences(text, variant)),
      );
    score += (field(title, 5) + field(url, 3) + field(snippet, 2)) * weight;
  });
  return score;
}

// Relevance for the fusion vote: idf-weighted token overlap over the result
// pool, gated on the query's rarest token. The weighted sum alone cannot tell
// three generic words ("handle nested objects") from three specific ones, but
// a page missing the most discriminative word is not an answer ("nested
// objects" in AutoMapper is not structuredclone). The gate discounts those
// pages hard. Weights cap so one token cannot dominate a small pool.
function poolRelevance(query: string, results: SearchResult[]): number[] {
  const groups = queryTokens(query).map(tokenVariants);
  const matched = results.map((result) => {
    const hay = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
    const words = hay.match(/[a-z0-9]+/g) ?? [];
    return groups.map(
      (variants) =>
        variants.some((variant) => hay.includes(variant)) ||
        // Family match: a word sharing a >=6-character prefix counts as the
        // same family, so "iteration" covers "iterators".
        words.some((word) =>
          variants.some((variant) => prefixLength(word, variant) >= 6),
        ),
    );
  });
  const weights = groups.map((variants, i) => {
    if (
      variants.some(
        (variant) =>
          QUESTION_STARTERS.has(variant) || RERANK_FILLER.has(variant),
      )
    )
      return 0;
    const df = matched.filter((row) => row[i]).length;
    return Math.min(10, results.length / Math.max(df, 1));
  });
  let anchor = -1;
  let anchorDf = Number.POSITIVE_INFINITY;
  groups.forEach((variants, i) => {
    if (weights[i] === 0) return;
    const df = matched.filter((row) => row[i]).length;
    if (df === 0) return;
    if (
      df < anchorDf ||
      (df === anchorDf &&
        anchor >= 0 &&
        variants[0]!.length > groups[anchor]![0]!.length)
    ) {
      anchor = i;
      anchorDf = df;
    }
  });
  return results.map((result, i) => {
    const base = relevanceScore(query, result, weights);
    if (anchor >= 0 && !matched[i]![anchor]) return base * 0.3;
    return base;
  });
}

export function relevantEnough(
  query: string,
  results: SearchResult[],
): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || results.length === 0) return true;
  return results.slice(0, 3).some((result) => {
    const hay = `${result.title} ${result.url}`.toLowerCase();
    return tokens.some((token) => hay.includes(token));
  });
}

// MDN's fuzzy index answers almost any word that appears in a web API name:
// "rust tokio select biased" returns HTML <select>, "typescript 7 release
// notes" returns Firefox 7 release notes, and "bun htmlrewriter" returns the
// Bun glossary. Those sets pass relevantEnough on one generic token. Ask MDN
// only when the query names the web platform or has no competing technology;
// otherwise its one-word matches outvote the real docs under the 1.6 weight.
// Only terms that belong to the web platform, not generic programming words:
// "rust async await" must not unlock MDN just because "async" appears.
const WEB_PLATFORM_QUERY =
  /\b(?:html5?|css|dom|javascript|js|ecmascript|web|browser|canvas|svg|webgl|webgpu|wasm|webassembly|queryselector|localstorage|sessionstorage|cookies?|serviceworkers?|websockets?|cors|typedarray|arraybuffer|formdata|abortcontroller|intl|accessibility|aria)\b/i;
const NON_WEB_TECH_QUERY =
  /\b(?:rust|tokio|golang?|python|django|flask|fastapi|java|kotlin|swift|ruby|rails|php|laravel|postgres(?:ql)?|mysql|sqlite|redis|mongo(?:db)?|kubernetes|k8s|docker|terraform|ansible|aws|azure|gcp|typescript|react|vue|svelte|angular|next(?:\.?js)?|nuxt|remix|astro|bun|deno|node(?:\.?js)?|npm|yarn|pnpm|cargo|pip|webpack|vite|eslint|jest|vitest|playwright|cypress|graphql|grpc)\b/i;
function mdnCanAnswer(query: string): boolean {
  return WEB_PLATFORM_QUERY.test(query) || !NON_WEB_TECH_QUERY.test(query);
}

// The qualifier usually comes last ("postgres 18 uuidv7" -> uuidv7, not the
// generic "postgres"), and a versioned token is almost always the topic
// ("htmlrewriter", "uuidv7"). Prefer the last token carrying a digit, else the
// last content token.
function anchorToken(tokens: string[]): string {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (/\d/.test(tokens[i]!)) return tokens[i]!;
  }
  return tokens[tokens.length - 1]!;
}

// Keyword dev fusion still keeps one-word near-misses in the tail ("Kubernetes
// MCP Server" for an ImagePullBackOff query). Drop a non-verified page unless
// it covers two content words or the query's most specific word; verified
// docs and repos are admitted separately and never pass through this gate.
export function survivesDevRelevance(
  query: string,
  result: SearchResult,
): boolean {
  const tokens = queryTokens(query).filter(
    (token) => !RERANK_FILLER.has(token) && !DEV_ASK_VERBS.has(token),
  );
  if (tokens.length === 0) return true;
  const anchor = anchorToken(tokens);
  const hay = `${result.title} ${result.url}`.toLowerCase();
  const matched = tokens.filter((token) => docTokenHit(hay, token));
  return matched.length >= 2 || matched.includes(anchor);
}

// The manual of a product named in the question is a candidate even when its
// title and URL carry only one query word ("typescript-4-9" for "typescript
// satisfies operator"). The page body decides its place, so the manual is
// pulled into the verification window instead of being dropped unread.
const OFFICIAL_DOC_PROMOTIONS = 2;
export function promoteOfficialDocs(
  query: string,
  fused: SearchResult[],
): SearchResult[] {
  const manuals = fused.filter((result) =>
    isOfficialDocPage(query, result.url),
  );
  if (manuals.length === 0) return fused;
  const promoted = manuals.slice(0, OFFICIAL_DOC_PROMOTIONS);
  const promotedKeys = new Set(
    promoted.map((result) => normalizeUrl(result.url)),
  );
  const rest = fused.filter(
    (result) => !promotedKeys.has(normalizeUrl(result.url)),
  );
  const keep = Math.max(0, RERANK_WINDOW - promoted.length);
  return [...rest.slice(0, keep), ...promoted, ...rest.slice(keep)];
}

// Keep the dev tail honest. A page whose body was read and evidenced the
// query survives; everything else has to carry the query in its title or URL.
export function devTailFilter(
  query: string,
  ordered: SearchResult[],
  verified: Set<string>,
): SearchResult[] {
  const filtered = ordered.filter(
    (result) =>
      verified.has(normalizeUrl(result.url)) ||
      survivesDevRelevance(query, result),
  );
  return filtered.length > 0 ? filtered : ordered;
}

// Buyer-research filler ("best", "review", the year) says nothing about the
// product. A page must carry the actual product noun to survive: a roundup of
// "nontoxic cookware" is not an answer to "best cast iron skillet 2026 review"
// even though it repeats every ranking word.
const PRODUCT_FILLER = new Set([
  "best",
  "top",
  "review",
  "reviews",
  "reviewed",
  "tested",
  "testing",
  "buy",
  "buying",
  "comparison",
  "guide",
  "for",
  "and",
  "the",
]);
function survivesProductRelevance(
  query: string,
  result: SearchResult,
): boolean {
  const tokens = queryTokens(query).filter(
    (token) => !PRODUCT_FILLER.has(token) && !/^(?:19|20)\d{2}$/.test(token),
  );
  if (tokens.length === 0) return true;
  return docTokenHit(
    `${result.title} ${result.url}`.toLowerCase(),
    anchorToken(tokens),
  );
}

// Cached pages are a local recall source, not an excuse to resurface an old
// unrelated page. The page must carry the query's most specific word: a
// Kubernetes MCP README mentioning "general-purpose" is not about the AI Act.
function survivesCorpusRelevance(query: string, result: SearchResult): boolean {
  const tokens = queryTokens(query).filter(
    (token) => !RERANK_FILLER.has(token) && !DEV_ASK_VERBS.has(token),
  );
  if (tokens.length === 0) return true;
  const hay = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  return docTokenHit(hay, anchorToken(tokens));
}

const QUESTION_STARTERS = new Set([
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "am",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
]);

const SCAFFOLDING_WORDS = new Set([
  ...QUESTION_STARTERS,
  "i",
  "you",
  "we",
  "my",
  "me",
  "your",
  "it",
  "its",
  "there",
  "that",
  "this",
  "the",
  "a",
  "an",
  "to",
  "be",
  "been",
  "being",
]);

// Reformulates plain-language questions into keyword queries for engines that
// match better on content words. Returns null for everything else: code
// punctuation means the query is already canonical, and a non-question is a
// keyword query that needs no reformulation.
export function topicQuery(query: string): string | null {
  if (/["'`.[\]{}()<>;=:|/\\]/.test(query)) return null;
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0 || !QUESTION_STARTERS.has(words[0]!)) return null;
  const kept = words.filter((word) => !SCAFFOLDING_WORDS.has(word));
  if (kept.length < 2) return null;
  return kept.join(" ");
}

// Appends the vocabulary-expansion terms when the alias table knows any of
// the keyword form's tokens; null when nothing was added.
function enrichAliases(base: string): string | null {
  const tokens = base.split(/\s+/).filter((token) => token.length > 0);
  const adds = aliasTokens(tokens);
  if (adds.length === 0) return null;
  return [...tokens, ...adds].join(" ");
}

// Turns one query into the interpretations worth spending engine requests on:
// the raw query, the keyword topic, and either a quoted phrase window (long
// content runs) or a title-style variant ("... explained" / "... internals"),
// which matches how real page titles are written. Non-questions stay at one
// variant, or two when the alias table expands them. Capped at three so the
// polite fan-out stays bounded.
export function variantsFor(query: string): string[] {
  const topic = topicQuery(query);
  if (!topic) {
    const enriched = enrichAliases(query);
    return enriched !== null && enriched !== query
      ? [query, enriched]
      : [query];
  }
  // Prepositions break phrase windows even where topicQuery keeps them ("in
  // javascript"): a quoted phrase like "work in javascript" over-restricts.
  const breakers = new Set([
    ...STOPWORDS,
    ...SCAFFOLDING_WORDS,
    "in",
    "under",
    "of",
    "on",
    "at",
    "by",
    "as",
    "or",
    "if",
    "so",
    "than",
    "then",
    "when",
    "while",
    "without",
  ]);
  const runs: string[][] = [[]];
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || breakers.has(word)) {
      if (runs[runs.length - 1]!.length > 0) runs.push([]);
    } else {
      runs[runs.length - 1]!.push(word);
    }
  }
  const longest = runs.reduce(
    (best, run) => (run.length > best.length ? run : best),
    [],
  );
  const howTo = /^how (do|can|should|would|to)\b/.test(
    query.trim().toLowerCase(),
  );
  // Generic verbs ("implement") dilute lexical engines: the short topic head
  // without them is what a real search engine ranks the canonical docs for
  // ("postgres mvcc" -> postgresql.org, "postgres implement mvcc" -> blogs).
  // It replaces the plain topic angle, so the variant set stays at three.
  const shortHead = queryTokens(topic)
    .filter((token) => !DEV_ASK_VERBS.has(token) && !RERANK_FILLER.has(token))
    .slice(0, 4)
    .join(" ");
  const topicVariant = shortHead !== "" ? shortHead : topic;
  const third =
    longest.length >= 4
      ? `"${longest.slice(-3).join(" ")}"`
      : `${topicVariant} ${
          /under the hood|internals?|internally/.test(query)
            ? "internals"
            : howTo
              ? "guide"
              : "explained"
        }`;
  const enrichedTopic = enrichAliases(topicVariant) ?? topicVariant;
  return [...new Set([query, enrichedTopic, third])];
}

// Doc sites render their search in JavaScript, but they publish server-side
// indexes: sitemaps and llms.txt. Match the query's distinctive tokens against
// the index, verify the candidates through the same page-evidence pass, and let
// the verified hits lead like the curated official asks.
interface DocsIndex {
  pattern: RegExp;
  url: string;
  kind: "sitemap" | "llms" | "inventory" | "curated" | "rss";
  include?: RegExp;
  entries?: { title: string; url: string }[];
  /** Curated set is entirely on-topic; keep fetched pages beyond the rerank coverage gate. */
  includeAll?: boolean;
}

// Prize announcements follow a stable official URL scheme, so the award's own
// press release and summary can be addressed directly instead of hoping a
// press roundup links to them.
const NOBEL_CATEGORIES: [string, string, string][] = [
  ["economic sciences", "economic-sciences", "Economic Sciences"],
  ["economics", "economic-sciences", "Economic Sciences"],
  ["physiology", "medicine", "Physiology or Medicine"],
  ["medicine", "medicine", "Physiology or Medicine"],
  ["physics", "physics", "Physics"],
  ["chemistry", "chemistry", "Chemistry"],
  ["literature", "literature", "Literature"],
  ["peace", "peace", "Peace"],
];

function nobelDocsIndex(query: string): DocsIndex | null {
  if (!/\bnobel prize\b/i.test(query)) return null;
  const year = /\b(?:19|20)\d{2}\b/.exec(query)?.[0];
  if (year === undefined) return null;
  const lower = query.toLowerCase();
  const found = NOBEL_CATEGORIES.find(([name]) =>
    new RegExp(`\\b${name}\\b`).test(lower),
  );
  if (found === undefined) return null;
  const [, slug, label] = found;
  const base = `https://www.nobelprize.org/prizes/${slug}/${year}`;
  return {
    pattern: /\bnobel prize\b/i,
    url: `curated:nobel-prize-${slug}-${year}`,
    kind: "curated",
    includeAll: true,
    entries: [
      {
        title: `Press release: Nobel Prize in ${label} ${year}`,
        url: `${base}/press-release/`,
      },
      {
        title: `Nobel Prize in ${label} ${year} summary`,
        url: `${base}/summary/`,
      },
    ],
  };
}

function findDocsIndex(query: string): DocsIndex | null {
  const dynamic = nobelDocsIndex(query);
  const indexes = dynamic === null ? DOCS_INDEXES : [dynamic, ...DOCS_INDEXES];
  return indexes.find((entry) => entry.pattern.test(query)) ?? null;
}

/**
 * Docs-index fetch: cache read, then polite fetch (5s deadline), then cache
 * write. Self-contained so it can be kicked early and awaited late.
 */
function docsIndexKick(docHost: DocsIndex, deps: SearchDeps): Promise<string> {
  return withDeadline(
    (async () => {
      const cacheKey = `docs-index:${docHost.url}`;
      const cached = await cacheGet<string>(cacheKey, false, deps);
      if (cached !== undefined) return cached;
      const response = await politeFetch(docHost.url, {}, deps);
      const text =
        docHost.kind === "inventory"
          ? inventoryText(new Uint8Array(await response.arrayBuffer()))
          : await response.text();
      if (text.length > 0) {
        await cacheSet(cacheKey, text, 24 * 60 * 60 * 1000, deps);
      }
      return text;
    })(),
    5_000,
    `docs index ${docHost.url}`,
  ).catch((error: unknown) => {
    // A failed index costs the docs pass candidates, not the whole search.
    console.error(
      `qany: docs index failed for ${docHost.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  });
}

const DOCS_INDEXES: DocsIndex[] = [
  {
    // The AI Act's own pages are the authority for obligations questions;
    // press coverage of enforcement is not a substitute for the regulation.
    pattern: /\b(?:eu\s+)?ai\s+act\b/i,
    url: "curated:eu-ai-act",
    kind: "curated",
    includeAll: true,
    entries: [
      {
        title: "General-purpose AI obligations under the AI Act",
        url: "https://digital-strategy.ec.europa.eu/en/factpages/general-purpose-ai-obligations-under-ai-act",
      },
      {
        title: "AI Act | Shaping Europe's digital future",
        url: "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai",
      },
      {
        title: "The General-Purpose AI Code of Practice",
        url: "https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai",
      },
      {
        title: "Guidelines for providers of general-purpose AI models",
        url: "https://digital-strategy.ec.europa.eu/en/policies/guidelines-gpai-providers",
      },
      {
        title: "General-Purpose AI Models in the AI Act - Questions & Answers",
        url: "https://digital-strategy.ec.europa.eu/en/faqs/general-purpose-ai-models-ai-act-questions-answers",
      },
      {
        title: "Regulation (EU) 2024/1689 (AI Act)",
        url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
      },
      {
        title: "Drawing-up a General-Purpose AI Code of Practice",
        url: "https://digital-strategy.ec.europa.eu/en/policies/ai-code-practice",
      },
      {
        title:
          "Questions and answers on the code of practice for General-Purpose AI",
        url: "https://digital-strategy.ec.europa.eu/en/faqs/questions-and-answers-code-practice-general-purpose-ai",
      },
    ],
  },
  {
    pattern: /\bpostgres(?:ql)?\b/i,
    url: "https://www.postgresql.org/sitemap.xml",
    kind: "sitemap",
    include: /\/docs\//,
  },
  {
    pattern: /\bkubernetes\b|\bk8s\b/i,
    url: "https://kubernetes.io/en/sitemap.xml",
    kind: "sitemap",
    include: /\/docs\//,
  },
  {
    pattern: /\bbun\b/i,
    url: "https://bun.com/sitemap.xml",
    kind: "sitemap",
    include: /\/(docs|guides)\//,
  },
  { pattern: /\breact\b/i, url: "https://react.dev/llms.txt", kind: "llms" },
  {
    pattern: /\bnode(?:\.?js)?\b/i,
    url: "https://nodejs.org/llms.txt",
    kind: "llms",
    include: /\/docs\//,
  },
  {
    pattern: /\bnext(?:\.?js)\b/i,
    url: "https://nextjs.org/docs/llms.txt",
    kind: "llms",
    include: /\/docs\//,
  },
  {
    pattern: /\bvue(?:\.?js)?\b/i,
    url: "https://vuejs.org/sitemap.xml",
    kind: "sitemap",
    include: /\/(guide|api|tutorial|examples)\//,
  },
  {
    pattern: /\bfastapi\b/i,
    url: "https://fastapi.tiangolo.com/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\bdocker\b/i,
    url: "https://docs.docker.com/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\bvite(?:\.?js)?\b/i,
    url: "https://vitejs.dev/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\bpython\b/i,
    url: "https://docs.python.org/3/objects.inv",
    kind: "inventory",
  },
  {
    pattern: /\bdjango\b/i,
    url: "https://docs.djangoproject.com/en/stable/objects.inv",
    kind: "inventory",
  },
  {
    pattern: /\brust\b/i,
    url: "curated:rust",
    kind: "curated",
    entries: [
      {
        title: "Validating References with Lifetimes",
        url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html",
      },
      {
        title: "Generic Data Types",
        url: "https://doc.rust-lang.org/book/ch10-01-syntax.html",
      },
      {
        title: "Traits: Defining Shared Behavior",
        url: "https://doc.rust-lang.org/book/ch10-02-traits.html",
      },
      {
        title: "What Is Ownership?",
        url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
      },
      {
        title: "References and Borrowing",
        url: "https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html",
      },
      {
        title: "Lifetimes",
        url: "https://doc.rust-lang.org/rust-by-example/scope/lifetime.html",
      },
      {
        title: "Lifetime elision",
        url: "https://doc.rust-lang.org/reference/lifetime-elision.html",
      },
      {
        title: "Lifetimes - The Rustonomicon",
        url: "https://doc.rust-lang.org/nomicon/lifetimes.html",
      },
      {
        title: "Lifetime annotations",
        url: "https://doc.rust-lang.org/rust-by-example/scope/lifetime/explicit.html",
      },
      {
        title: "Lifetime elision",
        url: "https://doc.rust-lang.org/rust-by-example/scope/lifetime/elision.html",
      },
      {
        title: "Static lifetimes",
        url: "https://doc.rust-lang.org/rust-by-example/scope/lifetime/static.html",
      },
      {
        title: "Closures",
        url: "https://doc.rust-lang.org/book/ch13-01-closures.html",
      },
      {
        title: "select in tokio",
        url: "https://docs.rs/tokio/latest/tokio/macro.select.html",
      },
      {
        title: "Select | Tokio tutorial",
        url: "https://tokio.rs/tokio/tutorial/select",
      },
      { title: "tokio - Rust", url: "https://docs.rs/tokio/latest/tokio/" },
    ],
  },
  {
    pattern: /\bgo\b|\bgolang\b/i,
    url: "curated:go",
    kind: "curated",
    entries: [
      {
        title: "An Introduction To Generics",
        url: "https://go.dev/doc/tutorial/generics",
      },
      { title: "Why Generics?", url: "https://go.dev/blog/why-generics" },
      { title: "Generics", url: "https://go.dev/doc/faq#generics" },
      {
        title: "When To Use Generics",
        url: "https://go.dev/blog/when-generics",
      },
      {
        title: "Generics in Go 1.18",
        url: "https://go.dev/doc/go1.18#generics",
      },
      { title: "Go 1.18 Release Notes", url: "https://go.dev/doc/go1.18" },
      { title: "Effective Go", url: "https://go.dev/doc/effective_go" },
      { title: "A Tour of Go", url: "https://go.dev/tour/" },
    ],
  },
  {
    pattern: /\btypescript\b.*\brelease\b|\brelease\b.*\btypescript\b/i,
    url: "https://devblogs.microsoft.com/typescript/feed/",
    kind: "rss",
  },
  {
    pattern: /\btypescript\b/i,
    url: "curated:typescript",
    kind: "curated",
    entries: [
      {
        title: "Announcing TypeScript 7.0",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/",
      },
      {
        title: "TypeScript 4.9: The satisfies Operator",
        url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
      },
      {
        title: "TypeScript Handbook: Generics",
        url: "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      },
      {
        title: "TypeScript Handbook: Narrowing",
        url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
      },
      {
        title: "TypeScript Handbook: Everyday Types",
        url: "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html",
      },
      {
        title: "TypeScript Documentation",
        url: "https://www.typescriptlang.org/docs/",
      },
    ],
  },
  {
    pattern: /\b(vaccin\w*|immuni[sz]\w*|vaccination|health|nhs)\b/i,
    url: "https://www.nhs.uk/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern:
      /\b(sky|lightning|volcano\w*|atmosphere|clouds?|rainbow|weather)\b/i,
    url: "https://scied.ucar.edu/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\brtings\b|\bheadphones?\b|\bearbuds?\b/i,
    url: "https://www.rtings.com/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\bopenai\b|\bgpt-?\d/i,
    url: "https://openai.com/news/rss.xml",
    kind: "rss",
  },
  {
    pattern: /\banthropic\b|\bclaude\b/i,
    url: "https://www.anthropic.com/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\broth\s?ira\b|\b401\s?\(?k\)?\b|\bretirement\b/i,
    url: "https://www.investor.gov/sitemap.xml",
    kind: "sitemap",
  },
  {
    pattern: /\bsvelte(?:\.?js)?\b/i,
    url: "curated:svelte",
    kind: "curated",
    entries: [
      {
        title: "What are runes?",
        url: "https://svelte.dev/docs/svelte/what-are-runes",
      },
      { title: "Introducing runes", url: "https://svelte.dev/blog/runes" },
      {
        title: "Migrating to Svelte 5",
        url: "https://svelte.dev/docs/svelte/v5-migration-guide",
      },
      { title: "$state", url: "https://svelte.dev/docs/svelte/$state" },
      { title: "$derived", url: "https://svelte.dev/docs/svelte/$derived" },
      { title: "$effect", url: "https://svelte.dev/docs/svelte/$effect" },
    ],
  },
  {
    pattern: /\bsqlite\b/i,
    url: "curated:sqlite",
    kind: "curated",
    entries: [
      { title: "Write-Ahead Logging", url: "https://www.sqlite.org/wal.html" },
      {
        title: "SQLite Documentation",
        url: "https://www.sqlite.org/docs.html",
      },
      { title: "Isolation", url: "https://www.sqlite.org/isolation.html" },
      {
        title: "WAL file format",
        url: "https://www.sqlite.org/fileformat2.html#wal",
      },
      { title: "PRAGMA statements", url: "https://www.sqlite.org/pragma.html" },
    ],
  },
];

// Doc indexes use slugs, so a query token and the page slug often differ only
// in their ending ("dependency" vs "dependencies"). Match the stem too.
function docTokenHit(hay: string, token: string): boolean {
  if (hay.includes(token)) return true;
  // Slugs join words with "-" or "_" ("html-rewriter"), while the query often
  // writes them solid ("htmlrewriter"). Compare the separator-free forms so
  // the exact page still matches.
  const compactHay = hay.replace(/[^a-z0-9]/g, "");
  const compactToken = token.replace(/[^a-z0-9]/g, "");
  if (compactToken.length >= 4 && compactHay.includes(compactToken))
    return true;
  if (token.length < 6) return false;
  const stem = token.slice(0, -2);
  return (
    stem.length >= 4 && compactHay.includes(stem.replace(/[^a-z0-9]/g, ""))
  );
}

export function docsFromSitemap(
  xml: string,
  tokens: string[],
  limit: number,
  include?: RegExp,
): SearchResult[] {
  const candidates: {
    url: string;
    title: string;
    coverage: number;
    current: number;
    length: number;
  }[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1]!.trim();
    if (seen.has(url) || (include !== undefined && !include.test(url)))
      continue;
    seen.add(url);
    // Match the whole path, not just the final slug: Bun's guide pages live
    // under /guides/html-rewriter/ while their last segment is "extract-links".
    const path = url
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    const coverage = tokens.filter((token) => docTokenHit(path, token)).length;
    if (coverage === 0) continue;
    candidates.push({
      url,
      title: (path.split("/").pop() ?? "")
        .replace(/\.html?$/i, "")
        .replace(/[-_]/g, " "),
      coverage,
      current: url.includes("/docs/current/") ? 0 : 1,
      length: path.length,
    });
  }
  candidates.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      a.current - b.current ||
      a.length - b.length ||
      (a.url < b.url ? -1 : 1),
  );
  return candidates
    .slice(0, limit)
    .map(({ url, title }) => ({ url, title, snippet: "", engine: "docs" }));
}

export function docsFromLlms(
  text: string,
  tokens: string[],
  limit: number,
  include?: RegExp,
): SearchResult[] {
  const candidates: {
    url: string;
    title: string;
    coverage: number;
    length: number;
  }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const title = match[1]!.trim();
    const url = match[2]!.trim().replace(/\.md$/i, "");
    if (seen.has(url) || (include !== undefined && !include.test(url)))
      continue;
    seen.add(url);
    const hay = `${title} ${url}`.toLowerCase();
    const coverage = tokens.filter((token) => docTokenHit(hay, token)).length;
    if (coverage === 0) continue;
    candidates.push({ url, title, coverage, length: url.length });
  }
  candidates.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      a.length - b.length ||
      (a.url < b.url ? -1 : 1),
  );
  return candidates
    .slice(0, limit)
    .map(({ url, title }) => ({ url, title, snippet: "", engine: "docs" }));
}

// Sphinx doc sites publish objects.inv: a short plain-text header followed by a
// zlib blob of "name role priority location display" lines. That inventory is
// the keyless index of every API object the site documents.
export function docsFromRss(
  xml: string,
  tokens: string[],
  limit: number,
): SearchResult[] {
  const items: {
    url: string;
    title: string;
    order: number;
    coverage: number;
  }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? "";
    const link =
      /<link>([\s\S]*?)<\/link>/i
        .exec(block)?.[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, "")
        .trim() ?? "";
    const rawTitle = /<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? "";
    const title = rawTitle
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (!/^https?:\/\//.test(link) || seen.has(link)) continue;
    seen.add(link);
    const coverage = tokens.filter((token) =>
      docTokenHit(`${title} ${link}`.toLowerCase(), token),
    ).length;
    if (coverage === 0) continue;
    items.push({
      url: link,
      title: title.length > 0 ? title : link,
      order,
      coverage,
    });
    order += 1;
  }
  items.sort((a, b) => b.coverage - a.coverage || a.order - b.order);
  return items
    .slice(0, limit)
    .map(({ url, title }) => ({ url, title, snippet: "", engine: "docs" }));
}

export function docsFromInventory(
  text: string,
  base: string,
  tokens: string[],
  limit: number,
): SearchResult[] {
  const candidates: {
    url: string;
    title: string;
    coverage: number;
    role: number;
    length: number;
  }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const name = parts[0]!;
    const role = parts[1]!;
    const location = parts[3]!;
    if (!role.startsWith("py:")) continue;
    const kind = role.slice(3);
    if (kind === "attribute" || kind === "data" || kind === "macro") continue;
    const hay = name.toLowerCase();
    const coverage = tokens.filter((token) => docTokenHit(hay, token)).length;
    if (coverage === 0) continue;
    let url: string;
    try {
      url = new URL(location.replace(/\$/g, name), base).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      url,
      title: name,
      coverage,
      role: kind === "module" ? 0 : kind === "class" ? 1 : 2,
      length: name.length,
    });
  }
  candidates.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      a.role - b.role ||
      a.length - b.length ||
      (a.url < b.url ? -1 : 1),
  );
  return candidates
    .slice(0, limit)
    .map(({ url, title }) => ({ url, title, snippet: "", engine: "docs" }));
}

// A handful of doc sites publish no index at all. Their core pages are stable
// enough to list: match the query's tokens against the titles and URLs.
export function docsFromCurated(
  entries: { title: string; url: string }[],
  tokens: string[],
  limit: number,
  preserveOrder = false,
): SearchResult[] {
  // Curated sets flagged includeAll are wholly on-topic: their listed order is
  // the intended answer order, so do not re-sort them by token coverage.
  if (preserveOrder) {
    return entries
      .slice(0, limit)
      .map((entry) => ({ ...entry, snippet: "", engine: "docs" }));
  }
  return entries
    .map((entry) => {
      const hay = `${entry.title} ${entry.url}`.toLowerCase();
      return {
        ...entry,
        coverage: tokens.filter((token) => docTokenHit(hay, token)).length,
      };
    })
    .filter((entry) => entry.coverage > 0)
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        a.url.length - b.url.length ||
        (a.url < b.url ? -1 : 1),
    )
    .slice(0, limit)
    .map(({ url, title }) => ({ url, title, snippet: "", engine: "docs" }));
}

// Sphinx inventories ship a short plain-text header followed by a zlib blob.
function inventoryText(buf: Uint8Array): string {
  let offset = -1;
  for (let line = 0; line < 4; line += 1) offset = buf.indexOf(10, offset + 1);
  if (offset < 0) return "";
  return new TextDecoder().decode(inflateSync(buf.slice(offset + 1)));
}

// Engines that surface source and spec pages: the expansion wave targets the
// web indexes plus the repo and docs indexes, where proposal/spec pages live.
const EXPANSION_ENGINES = new Set([
  "duckduckgo",
  "brave",
  "github",
  "mdn",
  "stackoverflow",
]);

// How many fetched pages feed the expansion mining. All of them: the df>=2
// and >=6-prefix filters are the guards, and a small pool makes the wave
// hostage to which pages happened to fetch cleanly that run.
const EXPANSION_POOL_SIZE = 6;

// The wave's evidence pass hoists verified hits, capped so the broad fusion
// keeps the rest of the list.
const MAX_WAVE_HOISTS = 3;
// The curated dev-source ask: repo-name hits, evidence-verified, capped.
const DEV_SOURCE_WINDOW = 5;
const MAX_DEV_HOISTS = 3;
// Generic verbs make bad repo-name asks: "implementing in:name" finds
// Terraform tutorials, not the library the question is asking about. When the
// mined term is one of these, the ask falls back to the topic phrase.
const DEV_ASK_VERBS = new Set([
  "implement",
  "implementing",
  "implementation",
  "implementations",
  "use",
  "using",
  "usage",
  "create",
  "creating",
  "creation",
  "build",
  "building",
  "write",
  "writing",
  "make",
  "making",
  "get",
  "getting",
  "add",
  "adding",
  "run",
  "running",
  "handle",
  "handling",
  "work",
  "working",
]);

// The official ask needs the shortest meaningful phrase: Bing News answers
// "eu ai" with eight EU official pages and "eu ai act high-risk obligations"
// with one. Unlike queryTokens, two-letter tokens stay (eu, ai, us, uk)
// because here they are the topic.
// The official-source ask belongs to policy and current-events queries. A
// product query ("best noise cancelling headphones 2026") can classify as news
// too, and the site: chain then returns government noise-control pages.
const NEWS_TOPIC =
  /\b(acts?|laws?|bills?|rules?|regulat\w*|policy|policies|bans?|fines?|tariffs?|sanctions?|court|elections?|treat(?:y|ies)|budget|tax|climate|emissions?|subsid\w*|schemes?|funding|ministry|parliament|congress|senate|commission|agency|authority|semiconductors?|chips?|crypto\w*|antitrust|privacy|merger|disclosure|reform)\b/i;

function newsTopic(query: string): boolean {
  return NEWS_TOPIC.test(query);
}

// Named regulators are the authority for their class, but most are not on a
// government TLD, so the site:gov chain and the authority bonus both miss
// them. When a query names one, ask its own domain first.
interface RegulatorDomain {
  pattern: RegExp;
  domain: string;
  sitemaps?: string[];
  include?: RegExp;
}

const REGULATOR_DOMAINS: RegulatorDomain[] = [
  {
    pattern: /\bfca\b/i,
    domain: "fca.org.uk",
    // The FCA search page renders navigation, not results, and the news
    // engine barely indexes the site. Its sitemap is server-rendered and
    // complete, so the regulator ask can read it directly.
    sitemaps: [
      "https://www.fca.org.uk/sitemap-main.xml?page=1",
      "https://www.fca.org.uk/sitemap-main.xml?page=2",
    ],
    include: /\/(publications|firms)\//,
  },
  { pattern: /\bsec\b/i, domain: "sec.gov" },
  { pattern: /\bofcom\b/i, domain: "ofcom.org.uk" },
  { pattern: /\bico\b/i, domain: "ico.org.uk" },
  { pattern: /\bftc\b/i, domain: "ftc.gov" },
  { pattern: /\bfda\b/i, domain: "fda.gov" },
  { pattern: /\bema\b/i, domain: "ema.europa.eu" },
];

function officialHead(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= 2 &&
        !STOPWORDS.has(token) &&
        !SCAFFOLDING_WORDS.has(token) &&
        !RERANK_FILLER.has(token),
    )
    .slice(0, 2);
  return tokens.join(" ") || query;
}

function devTopicHead(query: string): string {
  const topic = topicQuery(query) ?? query;
  return queryTokens(topic)
    .filter((token) => !DEV_ASK_VERBS.has(token))
    .slice(0, 2)
    .join(" ");
}

// Mining can come back empty (a pool with no family variants); the query's own
// topic phrase still names the library ("websocket reconnect in:name").
function devSourceQuery(
  query: string,
  mined: MinedExpansion | null,
): string | null {
  if (mined !== null && !DEV_ASK_VERBS.has(mined.top)) return mined.github;
  const head = devTopicHead(query);
  if (head !== "") return `${head} in:name`;
  return mined !== null ? mined.github : null;
}

// Longest shared prefix between two words.
function prefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// Longest shared prefix between a candidate word and any query token.
function bestPrefix(word: string, tokens: Set<string>): number {
  let best = 0;
  for (const token of tokens) {
    const length = prefixLength(word, token);
    if (length > best) best = length;
  }
  return best;
}

function novelWords(text: string): string[] {
  // Strip trailing dots/dashes/underscores so "iterator." and "iterator" are
  // the same term; interior dots stay ("symbol.asynciterator").
  return (text.toLowerCase().match(/[a-z][a-z0-9+#._-]*/g) ?? []).map((word) =>
    word.replace(/[._-]+$/, ""),
  );
}

// Pseudo-relevance feedback: mine the strongest fetched pages for the words
// the field actually uses but the query lacks ("iterators" -> "iteration"),
// and search once more with them. Morphological proximity is the filter: a
// candidate must share a >=6-character prefix with a query token, which keeps
// unrelated jargon out (and one-term expansions keep engines from flipping
// to the wrong topic; the winning expansion in live probes was exactly one
// sibling term). Title words need only their own page; body words need
// two-page consensus so page chrome cannot enter.
// Suffix shapes of real word-family siblings ("iteration", "iterate",
// "generating"); -ive/-ure style endings change the part of speech and never
// belong to the same family.
const FAMILY_ENDINGS = [
  "s",
  "es",
  "ing",
  "ed",
  "ion",
  "ions",
  "or",
  "ors",
  "er",
  "ers",
  "ate",
  "ates",
  "ating",
  "ist",
  "ists",
  "ism",
  "isms",
  "tion",
  "tions",
];

interface MinedExpansion {
  wave: string;
  github: string;
  top: string;
  terms: string[];
}

function mineExpansion(
  query: string,
  pool: { title: string; text: string }[],
): MinedExpansion | null {
  if (pool.length === 0) return null;
  const base = topicQuery(query) ?? query;
  const baseList = base
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const baseTokens = new Set(baseList);
  const covered = new Set<string>();
  for (const token of baseTokens) {
    covered.add(token);
    for (const variant of tokenVariants(token)) covered.add(variant);
  }
  const isNovel = (word: string): boolean =>
    word.length >= 4 &&
    !/^\d/.test(word) &&
    !covered.has(word) &&
    !STOPWORDS.has(word) &&
    !QUESTION_STARTERS.has(word);
  // Compound fragments ("structure" for "structuredclone") and part-of-speech
  // changers ("objective" for "objects") share prefixes without being the same
  // word family; both corrupt the wave query.
  const isFragment = (word: string): boolean =>
    baseList.some(
      (token) => token.length > word.length && token.startsWith(word),
    );
  const hasFamilyEnding = (word: string): boolean =>
    FAMILY_ENDINGS.some(
      (ending) => word.endsWith(ending) && word.length > ending.length + 2,
    );
  const isCandidate = (word: string): boolean =>
    isNovel(word) && !isFragment(word) && hasFamilyEnding(word);
  // "iterations" and "iteration" must count as the same term or two-page
  // consensus never sees the family.
  const normalizeTerm = (word: string): string =>
    word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;

  // A clipping that two titles independently use is the field's own short
  // name ("semicon" for "semiconductor"), not a compound fragment; one-title
  // fragments still fall to the family rules below.
  const titleDf = new Map<string, number>();
  for (const page of pool) {
    for (const rawWord of new Set(novelWords(page.title))) {
      const word = normalizeTerm(rawWord);
      if (isNovel(word)) titleDf.set(word, (titleDf.get(word) ?? 0) + 1);
    }
  }
  const scores = new Map<string, number>();
  const bodyDf = new Map<string, number>();
  for (const page of pool) {
    for (const rawWord of new Set(novelWords(page.title))) {
      const word = normalizeTerm(rawWord);
      if (!isCandidate(word) && (titleDf.get(word) ?? 0) < 2) continue;
      const prefix = bestPrefix(word, baseTokens);
      if (prefix >= 6)
        scores.set(word, Math.max(scores.get(word) ?? 0, prefix + 4));
    }
    const seen = new Set<string>();
    for (const rawWord of novelWords(page.text)) {
      const word = normalizeTerm(rawWord);
      if (!isCandidate(word) || seen.has(word)) continue;
      seen.add(word);
      bodyDf.set(word, (bodyDf.get(word) ?? 0) + 1);
    }
  }
  for (const [word, df] of bodyDf) {
    if (df < 2) continue;
    const prefix = bestPrefix(word, baseTokens);
    if (prefix < 6) continue;
    scores.set(word, Math.max(scores.get(word) ?? 0, prefix + Math.min(df, 3)));
  }
  if (scores.size === 0) return null;
  const terms = [...scores.entries()]
    .sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([word]) => word);
  // Keep the wave query short: engines (GitHub's repo search especially)
  // over-constrain on long queries, and the head noun phrase carries the
  // topic ("async iterators work under hood in javascript iteration" returns
  // nothing; "async iterators iteration" returns the spec repo first).
  const head = baseList.slice(0, 2).join(" ");
  const wave = `${head} ${terms.join(" ")}`;
  // Deterministic spec-repo finder: the mined sibling replaces its source
  // token and the search is restricted to repository names. "async iterators"
  // -> "async iteration in:name" returns tc39/proposal-async-iteration first,
  // every run (the plain keyword form varies between GitHub calls).
  const first = terms[0]!;
  const sourceIndex = baseList.findIndex(
    (token) => prefixLength(token, first) >= 6,
  );
  const preceding = sourceIndex > 0 ? baseList[sourceIndex - 1] : undefined;
  const github = `${preceding !== undefined ? `${preceding} ` : ""}${first} in:name`;
  return { wave, github, top: first, terms };
}

// The plain wave query (kept as the public shape tests and docs read).
export function expansionQuery(
  query: string,
  pool: { title: string; text: string }[],
): string | null {
  return mineExpansion(query, pool)?.wave ?? null;
}

interface StoredSearch {
  at: number;
  results: SearchResult[];
}

// Content-verified rerank: for question-shaped queries on the default engine
// list, fetch the top fused candidates and lift the ones whose page text
// actually evidences the query's content words. Lexical alternative to
// embedding rerankers, works with the existing fetchPage cache and politeness.
const RERANK_WINDOW = 6;
// The second pass (after the expansion wave) looks deeper, because the wave
// exists to surface pages the first fusion ranked low; they need evidence
// scoring to climb.
const RERANK_WINDOW_EXPANDED = 12;
const RERANK_MAX_CHARS = 6_000;
// One strong title hit (weight 5) or a handful of body hits clears this floor.
const RERANK_MIN_EVIDENCE = 8;
// Evidence must also cover most of the query's content words: a page that
// matches only the generic verb ("postgres implement CUBE") is not a strong
// answer to "postgres implement mvcc".
const RERANK_MIN_COVERAGE = 0.6;
const RERANK_LIFT_MIN_BASE = 6;
const RERANK_LIFT_MIN_WINDOW = 6;
// Question scaffolding: matching "how"/"work" alone must not pass page
// verification, or "How does the Internet work?" rides along on every
// question query.
const RERANK_FILLER = new Set([
  "how",
  "work",
  "works",
  "working",
  "under",
  "hood",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "you",
  "your",
  "want",
  "need",
  "handle",
  "handles",
  "handling",
]);

export function isQuestion(query: string): boolean {
  const first = query.trim().toLowerCase().split(/\s+/)[0];
  return (
    first !== undefined &&
    QUESTION_STARTERS.has(first.replace(/^[^a-z]+|[^a-z]+$/g, ""))
  );
}

interface RerankOutcome {
  results: SearchResult[];
  pool: { title: string; text: string }[];
  strong: Set<string>;
}

async function rerankQuestion(
  query: string,
  fused: SearchResult[],
  enabled: boolean,
  pageFetcher: (url: string) => Promise<FetchedPage>,
  onPromoted?: (promoted: number) => void,
  onVerdict?: (domain: string, passed: boolean) => void,
  windowSize: number = RERANK_WINDOW,
): Promise<RerankOutcome> {
  if (!enabled || fused.length === 0)
    return { results: fused, pool: [], strong: new Set() };
  const candidates = fused.slice(0, Math.min(windowSize, fused.length));
  const tails = fused.slice(candidates.length);
  // Evidence is judged on the query's content words: scaffolding like
  // "how"/"work" would otherwise verify pages that only share the question's
  // grammar, not its topic.
  const contentTokens = queryTokens(query).filter(
    (token) => !RERANK_FILLER.has(token) && !DEV_ASK_VERBS.has(token),
  );
  const scoreTokens =
    contentTokens.length > 0 ? contentTokens : queryTokens(query);
  // The evidence base reuses the fusion's rarity-weighted, anchor-gated
  // relevance: page text cannot promote a page that misses the query's most
  // discriminative token.
  const relevancePool = poolRelevance(query, fused);
  const fetched = await Promise.allSettled(
    candidates.map((result) => pageFetcher(result.url)),
  );
  const evidence = candidates.map((_result, i) => {
    const outcome = fetched[i];
    if (!outcome || outcome.status !== "fulfilled")
      return { score: 0, passageScore: 0, passage: "" };
    const base = relevancePool[i] ?? 0;
    // Whole-page token counts reward pages that merely SPRINKLE the query
    // words; scoring the densest window instead keeps verification honest,
    // because a real answer keeps its core words together in one paragraph.
    const picked = bestPassage(outcome.value.text, scoreTokens);
    return {
      score: base + picked.score,
      passageScore: picked.score,
      passage: picked.passage,
    };
  });
  const scores = evidence.map((entry) => entry.score);
  fetched.forEach((outcome, i) => {
    if (outcome.status !== "fulfilled") return;
    onVerdict?.(
      domainOf(candidates[i]!.url),
      scores[i]! >= RERANK_MIN_EVIDENCE,
    );
  });
  const strong = candidates
    .map((result, i) => {
      const passage = evidence[i]?.passage ?? "";
      const covered = scoreTokens.filter((token) =>
        passage.toLowerCase().includes(token),
      ).length;
      const coverage =
        scoreTokens.length === 0 ? 1 : covered / scoreTokens.length;
      return { result, original: i, evidence: scores[i]!, coverage };
    })
    .filter(
      (entry) =>
        entry.evidence >= RERANK_MIN_EVIDENCE &&
        entry.coverage >= RERANK_MIN_COVERAGE,
    )
    .sort((a, b) =>
      a.evidence !== b.evidence
        ? b.evidence - a.evidence
        : a.original - b.original,
    );
  for (const entry of strong) {
    const window = evidence[entry.original];
    // The page title/url/snippet must carry enough base evidence beyond the
    // window, and the window itself must hold at least two content words.
    if (!window || window.score - window.passageScore < RERANK_LIFT_MIN_BASE)
      continue;
    if (window.passageScore < RERANK_LIFT_MIN_WINDOW) continue;
    const lifted = window.passage.replace(/\s+/g, " ").trim().slice(0, 200);
    if (lifted) entry.result = { ...entry.result, snippet: lifted };
  }
  // Coverage-failing pages stay ranked below the head instead of vanishing:
  // the strong set excludes them, so weak must be "everything not strong".
  const strongOriginals = new Set(strong.map((entry) => entry.original));
  const weak = candidates.filter((_, i) => !strongOriginals.has(i));
  const head = [...strong.map((entry) => entry.result), ...weak];
  let promoted = 0;
  strong.forEach((entry) => {
    const arrived = head.indexOf(entry.result);
    if (arrived !== -1 && arrived < entry.original) promoted += 1;
  });
  if (promoted > 0) onPromoted?.(promoted);
  const pool = candidates
    .map((result, i) => {
      const outcome = fetched[i];
      return {
        title: result.title,
        text:
          outcome !== undefined && outcome.status === "fulfilled"
            ? outcome.value.text
            : "",
        evidence: scores[i]!,
      };
    })
    .filter((entry) => entry.text !== "")
    .sort((a, b) => b.evidence - a.evidence)
    .slice(0, EXPANSION_POOL_SIZE)
    .map(({ title, text }) => ({ title, text }));
  const strongKeys = new Set(
    strong.map((entry) => normalizeUrl(entry.result.url)),
  );
  return { results: [...head, ...tails], pool, strong: strongKeys };
}

export type SearchDeps = CacheDeps & {
  /** Query suggestion hook (DDG autocomplete by default); null disables. */
  suggest?: ((query: string) => Promise<string | null>) | null;
};

// Adds results to an engine's bucket without duplicates: one engine, one vote
// in the fusion no matter how many query variants or waves it answered.
function mergeBucket(
  buckets: Map<string, SearchResult[]>,
  name: string,
  results: SearchResult[],
  atFront = false,
): void {
  const bucket = buckets.get(name) ?? [];
  const seen = new Set(bucket.map((result) => normalizeUrl(result.url)));
  const fresh: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(result);
  }
  // Curated searches (the official-source ask) lead their bucket so RRF does
  // not bury them under the raw list; ordinary waves keep arrival order.
  if (atFront) bucket.unshift(...fresh);
  else bucket.push(...fresh);
  buckets.set(name, bucket);
}

export async function search(
  query: string,
  opts: SearchOptions = {},
  deps: SearchDeps = {},
): Promise<SearchResult[]> {
  const num = opts.num ?? DEFAULT_NUM;
  const intent = classifyIntent(query);
  const docsIndex = findDocsIndex(query);
  // The docs pass needs only the index text and it runs late in the pipeline;
  // kick the fetch here so it overlaps the engine round instead of trailing
  // it. Curated indexes need no fetch, and an explicit engine list is only
  // used by tests.
  const docsIndexText: Promise<string> | null =
    opts.engines === undefined &&
    docsIndex !== null &&
    docsIndex.kind !== "curated"
      ? docsIndexKick(docsIndex, deps)
      : null;
  // Slow or irrelevant engines cost more than they return for a given intent:
  // arXiv/OpenAlex time out on dev queries, while GitHub/npm/Stack Overflow
  // never answer a news or shopping query. Keep the fan-out to the sources
  // that can actually win, so the deadline is spent on useful work.
  const intentEngines: Record<typeof intent, Engine[]> = {
    dev: [
      ddgEngine,
      braveEngine,
      mwmblEngine,
      rightDaoEngine,
      bingEngine,
      hnEngine,
      wikiEngine,
      mdnEngine,
      stackoverflowEngine,
      npmEngine,
      githubEngine,
    ],
    news: [
      ddgEngine,
      braveEngine,
      mwmblEngine,
      bingEngine,
      newsEngine,
      hnEngine,
      wikiEngine,
    ],
    academic: [
      ddgEngine,
      braveEngine,
      bingEngine,
      wikiEngine,
      stackoverflowEngine,
      arxivEngine,
      openalexEngine,
    ],
    general: [
      ddgEngine,
      braveEngine,
      mwmblEngine,
      rightDaoEngine,
      bingEngine,
      newsEngine,
      hnEngine,
      wikiEngine,
    ],
  };
  const engines: Engine[] = opts.engines ?? intentEngines[intent];
  const key = `search:${query.toLowerCase()}:${num}:${engines.map((e) => e.name).join(",")}`;
  const now = deps.now ?? Date.now;

  let stale: SearchResult[] | undefined;
  if (!opts.noCache) {
    // allowExpired read: a fresh entry short-circuits; an old non-empty one is
    // kept as the fallback candidate instead of being deleted by a strict read.
    const stored = await cacheGet<StoredSearch>(key, true, deps);
    if (stored) {
      const ttl = stored.results.length > 0 ? CACHE_TTL_MS : EMPTY_TTL_MS;
      if (now() - stored.at < ttl) return stored.results;
      if (stored.results.length > 0) stale = stored.results;
    }
  }

  // Opt-in phase timings: "why is this query slow" should be answerable
  // without a profiler. QANY_TRACE=1 keeps stdout clean for JSON consumers.
  const startedAt = Date.now();
  const trace = (label: string): void => {
    if (process.env.QANY_TRACE === "1") {
      console.error(`qany: trace ${label} +${Date.now() - startedAt}ms`);
    }
  };

  // Engines whose underlying index matches better on reformulated variants
  // also run them; the rest run the raw query only.
  const VARIANT_ENGINES = new Set([
    "duckduckgo",
    "brave",
    "hn",
    "mdn",
    "stackoverflow",
    "npm",
  ]);
  // The general web engines are the only ones that serve challenges under
  // query volume. They get exactly one ask, the verb-filtered short head,
  // which is the angle that ranks canonical docs first ("postgres mvcc" ->
  // postgresql.org); every other engine keeps the raw query and its variants.
  const SINGLE_ASK_ENGINES = new Set(["duckduckgo", "brave"]);
  const variants = variantsFor(query);
  const shortHeadQuery =
    topicQuery(query) !== null ? (variants[1] ?? query) : query;
  // Circuit breaker: an engine that timed out recently (state persists next
  // to the cache) sits the run out instead of costing it two seconds again.
  const benched = new Set<string>();
  const liveEngines = engines.filter((engine) => {
    if (cooldownRemainingMs(`engine:${engine.name}`, now(), deps.dir) <= 0)
      return true;
    if (!benched.has(engine.name)) {
      console.error(`qany: engine ${engine.name} benched (cooling down)`);
      benched.add(engine.name);
    }
    return false;
  });
  const tasks: { engine: Engine; q: string }[] = [];
  for (const engine of liveEngines) {
    const single = SINGLE_ASK_ENGINES.has(engine.name);
    // Web engines get one ask for questions (the short head), but keep the
    // alias-enriched pair for keyword queries: "api throttling" must still
    // reach them as "api throttling rate limiting".
    const bases = single
      ? shortHeadQuery !== query
        ? [shortHeadQuery]
        : variants.slice(0, 2)
      : [query];
    for (const q of bases) tasks.push({ engine, q });
    for (const variant of variants.slice(1)) {
      if (VARIANT_ENGINES.has(engine.name) && !single)
        tasks.push({ engine, q: variant });
    }
  }

  // One engine, one vote: an engine that ran several variants merges them
  // into a single list (first occurrence wins) so variant coverage adds
  // recall without double-counting that engine in the fusion.
  const byEngine = new Map<string, SearchResult[]>();
  let settled: PromiseSettledResult<SearchResult[]>[] = [];
  let errors = 0;
  const engineTimeouts = new Map<string, number>();

  // Blackout gate for the fallback retry below: a round counts as a blackout
  // only when every engine call was rejected, and every rejection was a
  // timeout. A network blip kills all engines at once; a dead endpoint looks
  // the same, so both get one immediate re-ask before the slower suggestion
  // fallback (which swaps out the query) is allowed to run.
  let settledCount = 0;
  let rejectedCount = 0;
  let timedOutRejected = 0;
  const setRound = async (timeoutMs: number): Promise<void> => {
    settledCount = rejectedCount = timedOutRejected = 0;
    const round = await Promise.allSettled(
      tasks.map((task) =>
        withDeadline(
          task.engine.search(task.q, num),
          timeoutMs,
          `engine ${task.engine.name}`,
        ),
      ),
    );
    settled = round;
    settledCount = round.length;
    round.forEach((outcome, index) => {
      const task = tasks[index]!;
      if (outcome.status === "rejected") {
        rejectedCount += 1;
        errors += 1;
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        console.error(
          `qany: engine ${task.engine.name} failed for "${task.q}": ${reason}`,
        );
        if (/^engine .+ timed out/.test(reason)) {
          // A timeout on the long retry deadline counts double: eight seconds
          // of silence is a bench, two seconds is a slow network.
          const weight = timeoutMs >= ENGINE_RETRY_TIMEOUT_MS ? 2 : 1;
          engineTimeouts.set(
            task.engine.name,
            (engineTimeouts.get(task.engine.name) ?? 0) + weight,
          );
          timedOutRejected += 1;
        }
        return;
      }
      if (opts.guard !== false && !relevantEnough(task.q, outcome.value)) {
        console.error(
          `qany: dropped ${task.engine.name} results for "${task.q}" (no query overlap in top 3)`,
        );
        return;
      }
      if (
        opts.engines === undefined &&
        task.engine.name === "mdn" &&
        !mdnCanAnswer(query)
      ) {
        console.error(
          `qany: dropped ${task.engine.name} results for "${task.q}" (query is not web-platform)`,
        );
        return;
      }
      mergeBucket(byEngine, task.engine.name, outcome.value);
    });
  };
  await setRound(ENGINE_TIMEOUT_MS);
  if (
    byEngine.size === 0 &&
    settledCount > 0 &&
    rejectedCount === settledCount &&
    timedOutRejected === settledCount
  ) {
    console.error(
      "qany: every engine timed out; retrying once with a longer deadline",
    );
    await setRound(ENGINE_RETRY_TIMEOUT_MS);
  }
  for (const [name, count] of engineTimeouts) {
    if (count < 2) continue;
    recordChallenge(`engine:${name}`, now(), deps.dir);
    console.error(`qany: engine ${name} benched for 10m (${count} timeouts)`);
  }
  trace("engines");

  // Official sources for current-events queries: Bing News indexes government
  // and EU institution pages under a site: filter, which is the keyless path
  // to the official pages a hosted index returns directly. Only asked for
  // when the pool lacks official pages already, and guarded on the topic
  // alone so the site: operator's tokens cannot vouch for unrelated pages.
  // Curated official hits get lifted to the head of the final list after
  // fusion: the official search is both mined and guarded, so it outranks raw
  // press matches even when those match every query word.
  const officialLead: SearchResult[] = [];
  const devLead: SearchResult[] = [];
  // Pages whose body was read and evidenced the query. The dev tail gate
  // trusts that evidence over a title-and-URL guess.
  const evidenceVerified = new Set<string>();
  // A matching docs index already owns the official answer (EU AI Act,
  // Nobel); the news site: chain would only add seconds and duplicate pages.
  if ((opts.engines !== undefined || docsIndex === null) && newsTopic(query)) {
    // Officials already in the raw pool are lifted even when they arrived
    // buried: the curated search only runs when the pool lacks them, so one
    // engine's ordering luck never decides whether official pages lead.
    const poolOfficial = settled.flatMap((outcome) =>
      outcome.status === "fulfilled"
        ? outcome.value.filter(
            (result) =>
              authorityBonus(result.url) > 0 &&
              carriesSpecificToken(query, result),
          )
        : [],
    );
    const hasOfficial = poolOfficial.length > 0;
    officialLead.push(...poolOfficial);
    const officialEngine = engines.find((engine) => engine.name === "news");
    // A named regulator is its own official source: a stray gov page in the
    // pool (a funding announcement, say) must not suppress the regulator ask.
    const regulator = REGULATOR_DOMAINS.find((entry) =>
      entry.pattern.test(query),
    );
    if (
      officialEngine !== undefined &&
      (!hasOfficial || regulator !== undefined)
    ) {
      const topic = topicQuery(query) ?? query;
      // Bing News returns nothing for the full topic through the site: filter;
      // short queries carrying the topic's own vocabulary work. The pool
      // already has that vocabulary — press coverage of "SEMICON India 2026"
      // names the scheme the official pages use — so mine it with the same
      // prefix rule as the expansion wave and lead with the mined phrase.
      const pool = settled.flatMap((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : [],
      );
      const mined = mineExpansion(
        query,
        pool.map((result) => ({ title: result.title, text: "" })),
      );
      const head = officialHead(query);
      // Head plus the SINGLE top mined term: the two-term form returns nothing
      // from Bing News (probed: "india semiconductor semicon subsidy" -> 0,
      // "india semiconductor semicon" -> the official pages).
      const officialBase = mined !== null ? `${head} ${mined.top}` : head;
      const officialSites =
        "(site:gov OR site:gov.in OR site:gov.uk OR site:gov.au OR site:gov.br OR site:gov.za OR site:gc.ca OR site:gov.sg OR site:fca.org.uk OR site:europa.eu OR site:un.org OR site:who.int OR site:imf.org OR site:worldbank.org)";
      try {
        let official = await officialEngine.search(
          `${officialBase} ${officialSites}`,
          num,
        );
        // Only official pages answer an official-source ask; the site: chain
        // usually guarantees that, but a soft-throttled response can carry
        // unrelated items, so filter before trusting the list.
        official = official.filter((result) => authorityBonus(result.url) > 0);
        if (regulator !== undefined) {
          // Named regulators are not government TLDs, so the site: chain can
          // miss them even when they publish the rule. Ask their own domain
          // too and merge; a thin direct answer never removes the general one.
          const direct = await officialEngine.search(
            `site:${regulator.domain} ${officialBase}`,
            num,
          );
          const seenRegulator = new Set(
            official.map((result) => normalizeUrl(result.url)),
          );
          for (const result of direct) {
            if (!domainOf(result.url).endsWith(regulator.domain)) continue;
            if (!carriesSpecificToken(query, result)) continue;
            const key = normalizeUrl(result.url);
            if (seenRegulator.has(key)) continue;
            seenRegulator.add(key);
            official.push(result);
          }
        }
        if (regulator?.sitemaps !== undefined) {
          try {
            const fetchDoc =
              opts.pageFetcher ??
              ((url: string) =>
                fetchPage(url, { maxChars: RERANK_MAX_CHARS }, deps));
            const xml = (
              await Promise.all(
                regulator.sitemaps.map(async (url) => {
                  const cached = await cacheGet<string>(
                    `regulator-sitemap:${url}`,
                    false,
                    deps,
                  );
                  if (cached !== undefined) return cached;
                  const text = await (await politeFetch(url, {}, deps)).text();
                  await cacheSet(
                    `regulator-sitemap:${url}`,
                    text,
                    86_400_000,
                    deps,
                  );
                  return text;
                }),
              )
            ).join("");
            const docTokens = queryTokens(query).filter(
              (token) =>
                !RERANK_FILLER.has(token) &&
                !DEV_ASK_VERBS.has(token) &&
                !regulator.pattern.test(token) &&
                !/^(?:19|20)\d{2}$/.test(token),
            );
            const candidates = docsFromSitemap(
              xml,
              docTokens,
              7,
              regulator.include,
            );
            if (candidates.length > 0) {
              const fetched = await Promise.allSettled(
                candidates.map((candidate) => fetchDoc(candidate.url)),
              );
              const results = candidates.map((candidate, index) => {
                const page = fetched[index];
                return page !== undefined && page.status === "fulfilled"
                  ? {
                      ...candidate,
                      title: page.value.title,
                      snippet: page.value.text.slice(0, 200),
                    }
                  : candidate;
              });
              const verified = await rerankQuestion(
                docTokens.join(" "),
                results,
                true,
                fetchDoc,
                undefined,
                undefined,
                results.length,
              );
              const strong = verified.results.filter((result) =>
                verified.strong.has(normalizeUrl(result.url)),
              );
              const seenSitemap = new Set(
                official.map((result) => normalizeUrl(result.url)),
              );
              for (const result of strong.reverse()) {
                const key = normalizeUrl(result.url);
                if (seenSitemap.has(key)) continue;
                seenSitemap.add(key);
                official.unshift(result);
              }
            }
          } catch (error) {
            console.error(
              `qany: regulator sitemap failed for ${regulator.domain}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (official.length === 0) {
          // Bing News soft-throttles; the RSS index answers the same site:
          // filter, and the authority filter keeps only official pages.
          const rssEngine = engines.find((engine) => engine.name === "bing");
          if (rssEngine !== undefined) {
            const fallback = await rssEngine.search(
              `${officialBase} ${officialSites}`,
              num,
            );
            official = fallback.filter(
              (result) => authorityBonus(result.url) > 0,
            );
          }
        }
        // A thin first ask (the EU AI Act class returned a single page) gets a
        // second try with the runner-up term; each ask stays a single term
        // because two-term asks return nothing from Bing News.
        if (official.length < 3 && mined !== null && mined.terms.length > 1) {
          try {
            const more = await officialEngine.search(
              `${head} ${mined.terms[1]} ${officialSites}`,
              num,
            );
            const seen = new Set(
              official.map((result) => normalizeUrl(result.url)),
            );
            for (const result of more) {
              if (authorityBonus(result.url) <= 0) continue;
              const key = normalizeUrl(result.url);
              if (seen.has(key)) continue;
              seen.add(key);
              official.push(result);
            }
          } catch (error) {
            console.error(
              `qany: engine ${officialEngine.name} failed for the backup official ask: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // The bare head is the form Bing News answers best: the mined terms
        // narrow it to nothing ("eu ai harmonised" returns one page, "eu ai"
        // returns eight official pages). Asked only when the term asks left
        // the class thin.
        if (mined !== null && official.length < 3) {
          try {
            const bare = await officialEngine.search(
              `${head} ${officialSites}`,
              num,
            );
            const seen = new Set(
              official.map((result) => normalizeUrl(result.url)),
            );
            for (const result of bare) {
              if (authorityBonus(result.url) <= 0) continue;
              const key = normalizeUrl(result.url);
              if (seen.has(key)) continue;
              seen.add(key);
              official.push(result);
            }
          } catch (error) {
            console.error(
              `qany: engine ${officialEngine.name} failed for the bare official ask: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // When the pool already has an official page and the query names a
        // regulator, only that regulator answers the question: a site:gov
        // chain returns other institutions (the ECB for an SEC query) whose
        // authority would otherwise lift them above the named regulator.
        if (hasOfficial && regulator !== undefined) {
          official = official.filter((result) =>
            domainOf(result.url).endsWith(regulator.domain),
          );
        }
        // The official hits are curated (mined term + site: chain) and guarded,
        // so they lead the news bucket instead of trailing the raw list.
        if (relevantEnough(topic, official)) {
          mergeBucket(byEngine, officialEngine.name, official, true);
          officialLead.push(...official);
        }
      } catch (error) {
        errors += 1;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `qany: engine ${officialEngine.name} failed for official sources: ${reason}`,
        );
      }
    }
  }
  const perEngine: SearchResult[][] = [...byEngine.values()];
  const weights = [...byEngine.keys()].map((name) =>
    engineWeight(intent, name),
  );

  // Your own fetched pages are one more ranking vote: the corpus list rides
  // the same relevance guard as the engines, plus the anchor test that keeps
  // an old unrelated page from returning just because it shares a generic word.
  // A caller that asks for the engines alone (the eval baseline) turns it off.
  const local =
    opts.corpus === false
      ? []
      : corpusSearch(query, deps).filter((result) =>
          survivesCorpusRelevance(query, result),
        );
  if (local.length > 0 && relevantEnough(query, local)) {
    perEngine.push(local);
    weights.push(1);
  }

  const fused = fuseResults(
    query,
    perEngine,
    loadTrust(deps),
    weights,
    new Date(now()),
  );
  // Dev queries are keyword-shaped ("bun htmlrewriter", "tokio select biased"),
  // so isQuestion() alone left them unverified: the fusion could not tell a
  // real API page from an MDN page that matched one word. Run the same page
  // evidence pass for dev intent; it is what lifts canonical docs and repos.
  // When a docs index matches, its candidates are fetched and verified in the
  // docs pass below; running the generic page rerank first would duplicate the
  // same work and add seconds to every official/dev query.
  const enabled =
    opts.rerank ??
    (opts.engines === undefined &&
      docsIndex === null &&
      (isQuestion(query) || intent === "dev"));
  const rawPageFetcher =
    opts.pageFetcher ??
    ((url: string) => fetchPage(url, { maxChars: RERANK_MAX_CHARS }, deps));
  const pageFetcher = (url: string) =>
    withDeadline(rawPageFetcher(url), PAGE_TIMEOUT_MS, `page ${url}`);
  // A dev question about a product has one canonical manual. Engines bury it
  // under community answers, so the manual enters the verification window and
  // the page body decides its place.
  const promoteManuals =
    enabled && intent === "dev" && opts.engines === undefined;
  const rerankInput = promoteManuals
    ? promoteOfficialDocs(query, fused)
    : fused;
  const firstPass = await rerankQuestion(
    query,
    rerankInput,
    enabled,
    pageFetcher,
    (promoted) => {
      console.error(
        `qany: promoted ${promoted} results for "${query}" by page evidence`,
      );
    },
    (domain, passed) => recordVerdict(domain, passed, deps),
  );
  let ordered = firstPass.results;
  firstPass.strong.forEach((key) => evidenceVerified.add(key));
  trace("first-pass-rerank");

  // Pseudo-relevance expansion: mine the strongest verified pages for the
  // words the field uses but the query lacks, then run one more wave on the
  // engines that surface source and spec pages. The wave's results merge into
  // their engines' buckets, so no engine gets extra fusion votes.
  let mined: MinedExpansion | null = null;
  // Three verified pages already answer the query; the wave would spend
  // seconds looking for a fourth and can only reshuffle a settled head.
  const enoughEvidence =
    opts.engines === undefined && firstPass.strong.size >= 3;
  if (
    enabled &&
    firstPass.pool.length >= 2 &&
    !enoughEvidence &&
    Date.now() - startedAt < EXPANSION_BUDGET_MS
  ) {
    mined = mineExpansion(query, firstPass.pool);
    if (mined !== null) {
      const found = mined;
      console.error(`qany: expansion wave for "${query}": ${found.wave}`);
      const waveTasks = liveEngines
        .filter((engine) => EXPANSION_ENGINES.has(engine.name))
        .map((engine) => ({
          engine,
          // Repo names index the spec pages: for dev queries the sibling
          // term with its neighbor finds proposal-* repos deterministically.
          q:
            engine.name === "github" && intent === "dev"
              ? found.github
              : found.wave,
        }));
      const settledWave = await Promise.allSettled(
        waveTasks.map((task) =>
          withDeadline(
            task.engine.search(task.q, num),
            ENGINE_TIMEOUT_MS,
            `engine ${task.engine.name}`,
          ),
        ),
      );
      let added = false;
      const waveByEngine = new Map<string, SearchResult[]>();
      settledWave.forEach((outcome, index) => {
        const task = waveTasks[index]!;
        if (outcome.status === "rejected") {
          errors += 1;
          const reason =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          console.error(
            `qany: engine ${task.engine.name} failed for "${task.q}": ${reason}`,
          );
          return;
        }
        if (!relevantEnough(task.q, outcome.value)) {
          console.error(
            `qany: dropped ${task.engine.name} results for "${task.q}" (no query overlap in top 3)`,
          );
          return;
        }
        // The wave runs MDN too; the same web-platform gate applies, or a
        // Kubernetes query picks up MDN "Server" through the mined term.
        if (
          opts.engines === undefined &&
          task.engine.name === "mdn" &&
          !mdnCanAnswer(query)
        ) {
          console.error(
            `qany: dropped ${task.engine.name} results for "${task.q}" (query is not web-platform)`,
          );
          return;
        }
        mergeBucket(byEngine, task.engine.name, outcome.value);
        if (outcome.value.length > 0) {
          waveByEngine.set(task.engine.name, outcome.value);
          added = true;
        }
      });
      // Repo-name search finds what exact-name queries need: the spec repos
      // and libraries ("async iteration in:name" -> tc39/proposal-async-iteration,
      // "websocket reconnect in:name" -> reconnecting-websocket). The ask is
      // curated, so verified hits lead like the official ones. Started here so
      // it overlaps the post-wave rerank (both ride the same politeness
      // queues); consumed after `ordered` is computed.
      const sourcePass: Promise<SearchResult[]> | null =
        intent === "dev"
          ? (async () => {
              const githubEngine = liveEngines.find(
                (engine) => engine.name === "github",
              );
              if (githubEngine === undefined) return [];
              try {
                const repos = await githubEngine.search(
                  devSourceQuery(query, found) ?? found.github,
                  DEV_SOURCE_WINDOW,
                );
                if (repos.length > 0 && relevantEnough(query, repos)) {
                  const verified = await rerankQuestion(
                    query,
                    repos,
                    true,
                    pageFetcher,
                    undefined,
                    undefined,
                    repos.length,
                  );
                  return verified.results
                    .filter((result) =>
                      verified.strong.has(normalizeUrl(result.url)),
                    )
                    .slice(0, MAX_DEV_HOISTS);
                }
                return [];
              } catch (error) {
                console.error(
                  `qany: engine github failed for the source ask: ${error instanceof Error ? error.message : String(error)}`,
                );
                return [];
              }
            })()
          : null;
      if (added) {
        // The wave exists to surface pages the broad fusion under-ranks, so
        // its candidates get their own evidence pass: the top two per engine
        // (diversity beats one engine's long tail), and one that verifies
        // leads the final list, capped so the fusion keeps the rest.
        const waveCandidates: SearchResult[] = [];
        const candidateSeen = new Set<string>();
        for (const list of waveByEngine.values()) {
          const sorted = [...list].sort(
            (a, b) => relevanceScore(query, b) - relevanceScore(query, a),
          );
          for (const result of sorted.slice(0, 2)) {
            const key = normalizeUrl(result.url);
            if (candidateSeen.has(key)) continue;
            candidateSeen.add(key);
            waveCandidates.push(result);
          }
        }
        const waveEvidence = await rerankQuestion(
          query,
          waveCandidates,
          true,
          pageFetcher,
          undefined,
          undefined,
          waveCandidates.length,
        );
        const waveStrong = waveEvidence.results
          .filter((result) => waveEvidence.strong.has(normalizeUrl(result.url)))
          .slice(0, MAX_WAVE_HOISTS);
        waveEvidence.strong.forEach((key) => evidenceVerified.add(key));
        const fusedAgain = fuseResults(
          query,
          [...byEngine.values()],
          loadTrust(deps),
          [...byEngine.keys()].map((name) => engineWeight(intent, name)),
          new Date(now()),
        );
        const second = await rerankQuestion(
          query,
          fusedAgain,
          true,
          pageFetcher,
          undefined,
          undefined,
          RERANK_WINDOW_EXPANDED,
        );
        const hoisted = new Set(
          waveStrong.map((result) => normalizeUrl(result.url)),
        );
        second.strong.forEach((key) => evidenceVerified.add(key));
        ordered = [
          ...waveStrong,
          ...second.results.filter(
            (result) => !hoisted.has(normalizeUrl(result.url)),
          ),
        ];
      }
      if (sourcePass !== null) {
        devLead.push(...(await sourcePass));
      }
    }
  }

  // Repo-name search is the one dev-source path that must not depend on mining.
  if (
    enabled &&
    intent === "dev" &&
    mined === null &&
    !enoughEvidence &&
    Date.now() - startedAt < EXPANSION_BUDGET_MS
  ) {
    const githubEngine = engines.find((engine) => engine.name === "github");
    const ask = devSourceQuery(query, null);
    if (githubEngine !== undefined && ask !== null) {
      try {
        const repos = await githubEngine.search(ask, DEV_SOURCE_WINDOW);
        if (repos.length > 0 && relevantEnough(query, repos)) {
          const verified = await rerankQuestion(
            query,
            repos,
            true,
            pageFetcher,
            undefined,
            undefined,
            repos.length,
          );
          devLead.push(
            ...verified.results
              .filter((result) => verified.strong.has(normalizeUrl(result.url)))
              .slice(0, MAX_DEV_HOISTS),
          );
        }
      } catch (error) {
        console.error(
          `qany: engine github failed for the source ask: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  trace("expansion");
  // Doc sites render their search in JavaScript, but they publish server-side
  // indexes (sitemaps and llms.txt). Match the query's distinctive tokens
  // against the index, verify the candidates like any other source, and let
  // the verified hits lead even when the general web engines are throttled.
  if (opts.engines === undefined) {
    const docHost = docsIndex ?? undefined;
    const compounds =
      query.toLowerCase().match(/\b[a-z][a-z.-]*\d+(?:\.\d+)*\b/g) ?? [];
    const hostLabel =
      docHost !== undefined
        ? new URL(docHost.url).host
            .replace(/^www\./, "")
            .split(".")[0]!
            .toLowerCase()
        : "";
    const isHostToken = (token: string) =>
      hostLabel.length >= 3 &&
      (hostLabel.startsWith(token) || token.startsWith(hostLabel));
    const baseDocTokens = queryTokens(query).filter(
      (token) =>
        !RERANK_FILLER.has(token) &&
        !DEV_ASK_VERBS.has(token) &&
        !isHostToken(token),
    );
    const docTokens = [
      ...new Set([
        ...baseDocTokens,
        // Doc indexes use the field's own vocabulary ("troubleshooting" ->
        // "debug"), and the alias table is the keyless bridge to those slugs.
        ...aliasTokens(baseDocTokens).filter((token) => !isHostToken(token)),
        ...compounds.filter((token) => !isHostToken(token)),
      ]),
    ];
    if (docHost !== undefined && docTokens.length > 0) {
      try {
        // Index text came from the early kick (or was already resolved from
        // the cache against the kick's own 5s deadline); curated hosts never
        // needed one in the first place.
        const index =
          docHost.kind === "curated"
            ? ""
            : await (docsIndexText ?? Promise.resolve(""));
        const text = index;
        // Release feeds are versioned: "typescript 7 release notes" must rank
        // the 7.0 posts above the 6.0 ones that share the product name.
        const rssTokens =
          docHost.kind === "rss"
            ? [
                ...docTokens,
                ...new Set(
                  query.toLowerCase().match(/\b\d{1,2}(?:\.\d+)*\b/g) ?? [],
                ),
              ]
            : docTokens;
        let candidates =
          docHost.kind === "llms"
            ? docsFromLlms(text, docTokens, 7, docHost.include)
            : docHost.kind === "inventory"
              ? docsFromInventory(
                  text,
                  docHost.url.replace(/objects\.inv$/, ""),
                  docTokens,
                  7,
                )
              : docHost.kind === "curated"
                ? docsFromCurated(
                    docHost.entries ?? [],
                    docTokens,
                    7,
                    docHost.includeAll === true,
                  )
                : docHost.kind === "rss"
                  ? docsFromRss(text, rssTokens, 7)
                  : docsFromSitemap(text, docTokens, 7, docHost.include);
        if (
          candidates.length === 0 &&
          docHost.kind === "sitemap" &&
          /<sitemapindex[\s>]/.test(text)
        ) {
          const children = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)]
            .map((match) => match[1]!.trim())
            .filter((url) => /^https?:\/\//.test(url))
            .slice(0, 4);
          const parts: string[] = [];
          for (const child of children) {
            const childKey = `docs-index:${child}`;
            const cached = await cacheGet<string>(childKey, false, deps);
            if (cached !== undefined) {
              parts.push(cached);
              continue;
            }
            try {
              const childText = await (
                await withDeadline(
                  politeFetch(child, {}, deps),
                  5_000,
                  `docs sitemap ${child}`,
                )
              ).text();
              if (childText.length > 0) {
                await cacheSet(childKey, childText, 24 * 60 * 60 * 1000, deps);
                parts.push(childText);
              }
            } catch (error) {
              console.error(
                `qany: docs sitemap child failed for ${child}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (parts.length > 0) {
            candidates = docsFromSitemap(
              parts.join("\n"),
              docTokens,
              7,
              docHost.include,
            );
          }
        }
        if (candidates.length > 0) {
          const fetched = await Promise.allSettled(
            candidates.map((candidate) => pageFetcher(candidate.url)),
          );
          const results = candidates.map((candidate, index) => {
            const page = fetched[index];
            return page !== undefined && page.status === "fulfilled"
              ? {
                  ...candidate,
                  title: page.value.title,
                  snippet: page.value.text.slice(0, 200),
                }
              : candidate;
          });
          const verified = await rerankQuestion(
            query,
            results,
            true,
            pageFetcher,
            undefined,
            undefined,
            results.length,
          );
          const candidateRank = new Map(
            candidates.map((candidate, index) => [
              normalizeUrl(candidate.url),
              index,
            ]),
          );
          const strongDocs = verified.results
            .filter((result) => verified.strong.has(normalizeUrl(result.url)))
            .sort(
              (a, b) =>
                (candidateRank.get(normalizeUrl(a.url)) ?? candidates.length) -
                (candidateRank.get(normalizeUrl(b.url)) ?? candidates.length),
            );
          let docsLead = strongDocs;
          if (docHost.includeAll === true) {
            const seenDocs = new Set(
              strongDocs.map((result) => normalizeUrl(result.url)),
            );
            results.forEach((result, index) => {
              const key = normalizeUrl(result.url);
              const page = fetched[index];
              if (
                seenDocs.has(key) ||
                page === undefined ||
                page.status !== "fulfilled"
              )
                return;
              // Soft-404 pages return HTTP 200; their title is the only reliable
              // signal that the curated URL no longer exists.
              if (/\b(?:page not found|404)\b/i.test(result.title)) return;
              seenDocs.add(key);
              docsLead.push(result);
            });
            // Keep curation order: the obligation factpage stays before the
            // regulation and the explainer, regardless of passage density.
            const curatedRank = new Map(
              (docHost.entries ?? []).map((entry, index) => [
                normalizeUrl(entry.url),
                index,
              ]),
            );
            docsLead = [...docsLead].sort(
              (a, b) =>
                (curatedRank.get(normalizeUrl(a.url)) ?? candidates.length) -
                (curatedRank.get(normalizeUrl(b.url)) ?? candidates.length),
            );
          }
          devLead.unshift(...docsLead.slice(0, 5));
        }
      } catch (error) {
        console.error(
          `qany: docs index failed for ${docHost.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Curated official hits lead the whole list: the official search is the one
  // source that is both mined and guarded, so it outranks raw press matches
  // even when those match every query word.
  if (officialLead.length > 0) {
    const leadKeys = new Set(
      officialLead.map((result) => normalizeUrl(result.url)),
    );
    const lead = ordered.filter((result) =>
      leadKeys.has(normalizeUrl(result.url)),
    );
    ordered = [
      ...lead,
      ...ordered.filter((result) => !leadKeys.has(normalizeUrl(result.url))),
    ];
  }

  // Verified dev-source hits lead too: a proposal repo or library whose name
  // matches the query's vocabulary is the page the question is asking about.
  if (devLead.length > 0) {
    const leadKeys = new Set(devLead.map((result) => normalizeUrl(result.url)));
    ordered = [
      ...devLead,
      ...ordered.filter((result) => !leadKeys.has(normalizeUrl(result.url))),
    ];
  }

  // Keep the dev tail honest. Pages whose body was read are exempt because
  // their evidence came from the page, not from a title-and-URL guess.
  if (opts.engines === undefined && intent === "dev" && ordered.length > 0) {
    devLead.forEach((result) => evidenceVerified.add(normalizeUrl(result.url)));
    ordered = devTailFilter(query, ordered, evidenceVerified);
  }

  // Buyer-research queries attract broad "cookware" roundups that repeat the
  // ranking words but not the product. Drop them only when enough real
  // candidates remain, so a thin result set is never filtered to nothing.
  if (
    opts.engines === undefined &&
    isProductQuery(query) &&
    ordered.length > 0
  ) {
    const filtered = ordered.filter((result) =>
      survivesProductRelevance(query, result),
    );
    if (filtered.length >= 3) ordered = filtered;
  }

  trace("docs");
  const ranked = ordered.slice(0, num);
  if (ranked.length > 0) {
    if (!opts.noCache) {
      await cacheSet(
        key,
        { at: now(), results: ranked } satisfies StoredSearch,
        CACHE_TTL_MS,
        deps,
      );
    }
    return ranked;
  }

  // Nothing came back: give the engines one second chance with DuckDuckGo's
  // autocomplete suggestion (spelling and vocabulary fixes). Skipped when the
  // caller disabled suggestions or the query is too long to be a typo.
  const trimmed = query.trim();
  if (
    !opts.noCache &&
    deps.suggest !== null &&
    trimmed.length > 0 &&
    trimmed.length <= 80
  ) {
    const suggest = deps.suggest ?? suggestQuery;
    const suggestion = await suggest(trimmed);
    if (
      suggestion !== null &&
      suggestion.toLowerCase() !== trimmed.toLowerCase() &&
      sharesVocabulary(trimmed, suggestion)
    ) {
      console.error(
        `qany: no results; retrying with suggestion: ${suggestion}`,
      );
      const retried = await search(
        suggestion,
        { ...opts, noCache: true },
        { ...deps, suggest: null },
      );
      if (retried.length > 0) {
        await cacheSet(
          key,
          { at: now(), results: retried } satisfies StoredSearch,
          CACHE_TTL_MS,
          deps,
        );
        return retried;
      }
    }
  }

  if (stale !== undefined) {
    console.error(
      `qany: serving stale results for "${query}" (engines returned nothing)`,
    );
    return stale;
  }
  if (tasks.length > 0 && settledCount > 0 && rejectedCount === settledCount) {
    throw new Error(`all engines failed for query "${query}"`);
  }
  if (!opts.noCache) {
    // Cache the empty outcome briefly so repeated misses skip the engines.
    await cacheSet(
      key,
      { at: now(), results: [] } satisfies StoredSearch,
      EMPTY_TTL_MS,
      deps,
    );
  }
  return [];
}
