import { cooldownRemainingMs, recordChallenge } from "./cooldown";
import { politeFetch, type HttpDeps } from "./http";
import type { Engine, SearchResult } from "./types";

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function decodeDdgHref(href: string): string {
  const abs = href.startsWith("//") ? `https:${href}` : href;
  let url: URL;
  try {
    url = new URL(abs);
  } catch {
    // Malformed href; hand back exactly what the page gave us.
    return href;
  }
  if (
    url.hostname.endsWith("duckduckgo.com") &&
    url.pathname.startsWith("/l/")
  ) {
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
  }
  return url.toString();
}

export function isDdgChallenge(html: string): boolean {
  return /anomaly-modal|duckduckgo\.com\/anomaly/.test(html);
}

export async function parseDdgHtml(html: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let current: { title: string; url: string; snippet: string } | null = null;
  let mode: "title" | "snippet" | null = null;

  const push = () => {
    if (!current) return;
    const title = collapse(decodeEntities(current.title));
    const snippet = collapse(decodeEntities(current.snippet));
    if (title && current.url) {
      results.push({ title, url: current.url, snippet, engine: "duckduckgo" });
    }
    current = null;
  };

  const rewriter = new HTMLRewriter()
    .on("a.result__a", {
      element(el) {
        push();
        current = {
          title: "",
          url: decodeDdgHref(el.getAttribute("href") ?? ""),
          snippet: "",
        };
        mode = "title";
      },
      text(chunk) {
        if (current && mode === "title") current.title += chunk.text;
      },
    })
    .on("a.result__snippet", {
      element() {
        mode = "snippet";
      },
      text(chunk) {
        if (current && mode === "snippet") current.snippet += chunk.text;
      },
    });

  // Bun's transform(string) runs the handlers synchronously and returns the
  // rewritten string; undici-style runtimes return a Response instead.
  const transformed: unknown = rewriter.transform(html);
  if (transformed instanceof Response) await transformed.text();
  push();
  return results;
}

function firstTag(xml: string, tag: string): string | null {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return match ? match[1]! : null;
}

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

function safeCodePoint(cp: number): string {
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, "&");
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseBingRss(xml: string): SearchResult[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const item of items) {
    const titleRaw = firstTag(item, "title");
    const linkRaw = firstTag(item, "link");
    if (!titleRaw || !linkRaw) continue;
    const url = decodeEntities(stripCdata(linkRaw)).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (hostname === "bing.com" || hostname.endsWith(".bing.com")) continue;
    const title = stripTags(decodeEntities(stripCdata(titleRaw)));
    if (!title) continue;
    const descRaw = firstTag(item, "description") ?? "";
    const snippet = stripTags(decodeEntities(stripCdata(descRaw)));
    results.push({ title, url, snippet, engine: "bing" });
  }
  return results;
}

function decodeBingNewsLink(raw: string): string | null {
  const decoded = decodeEntities(stripCdata(raw)).trim();
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(url.protocol)) return null;
  if (url.hostname === "bing.com" || url.hostname.endsWith(".bing.com")) {
    const target = url.searchParams.get("url");
    if (!target) return null;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return null;
    }
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : null;
  }
  return url.toString();
}

export function parseBingNewsRss(xml: string): SearchResult[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const item of items) {
    const titleRaw = firstTag(item, "title");
    const linkRaw = firstTag(item, "link");
    if (!titleRaw || !linkRaw) continue;
    const url = decodeBingNewsLink(linkRaw);
    if (!url) continue;
    const title = stripTags(decodeEntities(stripCdata(titleRaw)));
    if (!title) continue;
    const descRaw = firstTag(item, "description") ?? "";
    let snippet = stripTags(decodeEntities(stripCdata(descRaw)));
    if (!snippet) {
      snippet = stripTags(
        decodeEntities(stripCdata(firstTag(item, "News:Source") ?? "")),
      );
    }
    results.push({ title, url, snippet, engine: "news" });
  }
  return results;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseHnJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const hits = root && Array.isArray(root.hits) ? root.hits : [];
  const results: SearchResult[] = [];
  for (const raw of hits) {
    const hit = asRecord(raw);
    if (!hit) continue;
    const title = asString(hit.title) ?? asString(hit.story_title);
    const objectId =
      asString(hit.objectID) ??
      (typeof hit.objectID === "number" ? String(hit.objectID) : null);
    const url =
      asString(hit.url) ??
      (objectId ? `https://news.ycombinator.com/item?id=${objectId}` : null);
    if (!title || !url) continue;
    const points = typeof hit.points === "number" ? hit.points : 0;
    results.push({
      title: collapse(title),
      url,
      snippet: `HN · ${points} points`,
      engine: "hn",
    });
  }
  return results;
}

export function parseWikiJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const query = root ? asRecord(root.query) : null;
  const search = query && Array.isArray(query.search) ? query.search : [];
  const results: SearchResult[] = [];
  for (const raw of search) {
    const page = asRecord(raw);
    if (!page) continue;
    const title = asString(page.title);
    if (!title) continue;
    const snippet = stripTags(decodeEntities(asString(page.snippet) ?? ""));
    results.push({
      title: collapse(title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/gi, "/")}`,
      snippet,
      engine: "wiki",
    });
  }
  return results;
}

export function isBraveChallenge(html: string): boolean {
  return /<title[^>]*>[^<]*(captcha|denied|attention)|cf-chl|captcha-required/i.test(
    html,
  );
}

// DuckDuckGo autocomplete: keyless spellcheck + vocabulary hint for queries
// that returned nothing. Returns the first suggestion that differs from the
// input, or null when the service is down, returns junk, or only echoes the
// input back.
export async function suggestQuery(
  query: string,
  deps: HttpDeps = {},
): Promise<string | null> {
  const url = `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`;
  let data: unknown;
  try {
    const res = await politeFetch(
      url,
      { minIntervalMs: 300, retries: 1 },
      deps,
    );
    if (res.status !== 200) return null;
    data = await res.json();
  } catch {
    // Suggestion is a bonus path; a dead autocomplete must not fail a search.
    return null;
  }
  if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1]))
    return null;
  const input = query.trim().toLowerCase();
  for (const raw of data[1]) {
    if (typeof raw !== "string") continue;
    const suggestion = raw.trim();
    if (suggestion !== "" && suggestion.toLowerCase() !== input)
      return suggestion;
  }
  return null;
}

export async function parseBraveHtml(html: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const hrefStack: (string | null)[] = [];
  let currentUrl: string | null = null;
  let title = "";
  let snippet = "";
  let inTitle = false;
  let inSnippet = false;

  const push = () => {
    const cleanTitle = collapse(decodeEntities(title));
    const cleanSnippet = collapse(decodeEntities(snippet)).replace(
      /^[A-Z][a-z]+ \d{1,2}, \d{4} - /,
      "",
    );
    if (currentUrl && cleanTitle && !seenUrls.has(currentUrl)) {
      seenUrls.add(currentUrl);
      results.push({
        title: cleanTitle,
        url: currentUrl,
        snippet: cleanSnippet,
        engine: "brave",
      });
    }
    currentUrl = null;
    title = "";
    snippet = "";
    inTitle = false;
    inSnippet = false;
  };

  const rewriter = new HTMLRewriter()
    .on("a", {
      element(el) {
        // Worklets fire only on element start. Each result's title div sits
        // inside its anchor, so the last href opened before a title div is
        // that result's href; every href seen since the previous title stays
        // on the stack and is simply superseded by the next title.
        hrefStack.push(el.getAttribute("href"));
      },
    })
    .on("div.search-snippet-title", {
      element() {
        push();
        const href = hrefStack.length ? hrefStack[hrefStack.length - 1] : null;
        if (href && /^https?:\/\//i.test(href)) {
          try {
            const hostname = new URL(href).hostname;
            if (hostname !== "brave.com" && !hostname.endsWith(".brave.com"))
              currentUrl = href;
          } catch {
            currentUrl = null;
          }
        }
        title = "";
        inTitle = true;
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
      },
    })
    .on("div.generic-snippet div.content", {
      element() {
        snippet = "";
        inSnippet = true;
      },
      text(chunk) {
        if (inSnippet) snippet += chunk.text;
      },
    });

  // Bun's transform(string) runs the handlers synchronously and returns the
  // rewritten string; undici-style runtimes return a Response instead.
  const transformed: unknown = rewriter.transform(html);
  if (transformed instanceof Response) await transformed.text();
  push();
  return results;
}

export function parseGithubJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const items = root && Array.isArray(root.items) ? root.items : [];
  const results: SearchResult[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const name = asString(item.full_name);
    const url = asString(item.html_url);
    if (!name || !url || !url.startsWith("https://github.com/")) continue;
    const description = asString(item.description);
    const stars =
      typeof item.stargazers_count === "number" ? item.stargazers_count : 0;
    results.push({
      title: collapse(name),
      url,
      snippet: description ? collapse(description) : `GH · ${stars} stars`,
      engine: "github",
    });
  }
  return results;
}

export function parseNpmJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const objects = root && Array.isArray(root.objects) ? root.objects : [];
  const results: SearchResult[] = [];
  for (const raw of objects) {
    const entry = asRecord(raw);
    const pkg = entry ? asRecord(entry.package) : null;
    if (!pkg) continue;
    const name = asString(pkg.name);
    if (!name) continue;
    const links = asRecord(pkg.links);
    const url =
      (links ? asString(links.npm) : null) ??
      `https://www.npmjs.com/package/${name}`;
    results.push({
      title: collapse(name),
      url,
      snippet: collapse(asString(pkg.description) ?? ""),
      engine: "npm",
    });
  }
  return results;
}

export function parseArxivXml(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = match[1]!;
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1];
    const id = /<id>([\s\S]*?)<\/id>/.exec(body)?.[1];
    if (!title || !id) continue;
    const url = id
      .trim()
      .replace(/^http:/, "https:")
      .replace(/v\d+$/, "");
    if (!url.startsWith("https://arxiv.org/abs/")) continue;
    const summary = collapse(
      decodeEntities(/<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1] ?? ""),
    );
    results.push({
      title: collapse(decodeEntities(title)),
      url,
      snippet:
        summary.length > 220 ? `${summary.slice(0, 219).trimEnd()}…` : summary,
      engine: "arxiv",
    });
  }
  return results;
}

export function parseOpenAlexJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const works = root && Array.isArray(root.results) ? root.results : [];
  const results: SearchResult[] = [];
  for (const raw of works) {
    const work = asRecord(raw);
    if (!work) continue;
    const title = asString(work.display_name);
    if (!title) continue;
    const location = asRecord(work.primary_location);
    const url =
      (location ? asString(location.landing_page_url) : null) ??
      asString(work.doi) ??
      asString(work.id);
    if (!url) continue;
    const bits: string[] = [];
    if (typeof work.publication_year === "number")
      bits.push(String(work.publication_year));
    if (typeof work.cited_by_count === "number")
      bits.push(`${work.cited_by_count} citations`);
    results.push({
      title: collapse(title),
      url,
      snippet: bits.join(" · "),
      engine: "openalex",
    });
  }
  return results;
}

export function parseMdnJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const documents = root && Array.isArray(root.documents) ? root.documents : [];
  const results: SearchResult[] = [];
  for (const raw of documents) {
    const doc = asRecord(raw);
    if (!doc) continue;
    const path = asString(doc.mdn_url);
    const title = asString(doc.title);
    if (!path || !title) continue;
    results.push({
      title: collapse(title),
      url: `https://developer.mozilla.org${path}`,
      snippet: collapse(asString(doc.summary) ?? ""),
      engine: "mdn",
    });
  }
  return results;
}

export function parseStackExchangeJson(data: unknown): SearchResult[] {
  const root = asRecord(data);
  const items = root && Array.isArray(root.items) ? root.items : [];
  const results: SearchResult[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const link = asString(item.link);
    const title = asString(item.title);
    if (!link || !title || !/^https?:\/\//i.test(link)) continue;
    const score = typeof item.score === "number" ? item.score : 0;
    const answers =
      typeof item.answer_count === "number" ? item.answer_count : 0;
    results.push({
      title: collapse(title),
      url: link,
      snippet: `SO · score ${score} · ${answers} answer${answers === 1 ? "" : "s"}`,
      engine: "stackoverflow",
    });
  }
  return results;
}

export function makeDdgEngine(deps: HttpDeps = {}): Engine {
  const now = deps.now ?? Date.now;
  let challengedUntil = 0;
  return {
    name: "duckduckgo",
    minIntervalMs: 1_100,
    async search(query, num) {
      if (now() < challengedUntil) return [];
      const persisted = cooldownRemainingMs("duckduckgo", now(), deps.dir);
      if (persisted > 0) {
        challengedUntil = now() + persisted;
        console.error(
          `qany: duckduckgo cooling down for ${Math.ceil(persisted / 60_000)} more minutes`,
        );
        return [];
      }
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      try {
        const res = await politeFetch(
          url,
          { minIntervalMs: 1_100, retries: 1 },
          deps,
        );
        const body = await res.text();
        if (res.status === 202 || isDdgChallenge(body)) {
          const duration = recordChallenge("duckduckgo", now(), deps.dir);
          challengedUntil = now() + duration;
          console.error(
            `qany: duckduckgo served a challenge, cooling down for ${Math.round(duration / 60_000)} minutes`,
          );
          return [];
        }
        return (await parseDdgHtml(body)).slice(0, num);
      } catch (error) {
        // An unreachable endpoint is as good as challenged: bench it so every
        // later run does not pay the timeout again.
        const duration = recordChallenge("duckduckgo", now(), deps.dir);
        challengedUntil = now() + duration;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `qany: duckduckgo unreachable (${reason.slice(0, 100)}), cooling down for ${Math.round(duration / 60_000)} minutes`,
        );
        return [];
      }
    },
  };
}

export function makeBingEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "bing",
    minIntervalMs: 1_100,
    async search(query, num) {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 1_100, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseBingRss(await res.text()).slice(0, num);
    },
  };
}

export function makeBraveEngine(deps: HttpDeps = {}): Engine {
  const now = deps.now ?? Date.now;
  let challengedUntil = 0;
  return {
    name: "brave",
    minIntervalMs: 1_100,
    async search(query, num) {
      if (now() < challengedUntil) return [];
      const persisted = cooldownRemainingMs("brave", now(), deps.dir);
      if (persisted > 0) {
        challengedUntil = now() + persisted;
        console.error(
          `qany: brave cooling down for ${Math.ceil(persisted / 60_000)} more minutes`,
        );
        return [];
      }
      const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
      try {
        const res = await politeFetch(
          url,
          { minIntervalMs: 1_100, retries: 1 },
          deps,
        );
        const body = await res.text();
        if (res.status !== 200 || isBraveChallenge(body)) {
          const duration = recordChallenge("brave", now(), deps.dir);
          challengedUntil = now() + duration;
          console.error(
            `qany: brave served a challenge, cooling down for ${Math.round(duration / 60_000)} minutes`,
          );
          return [];
        }
        return (await parseBraveHtml(body)).slice(0, num);
      } catch (error) {
        const duration = recordChallenge("brave", now(), deps.dir);
        challengedUntil = now() + duration;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `qany: brave unreachable (${reason.slice(0, 100)}), cooling down for ${Math.round(duration / 60_000)} minutes`,
        );
        return [];
      }
    },
  };
}

// Mwmbl is a community-built, keyless web index: the supplementary web list
// when DuckDuckGo and Brave are cooling down. Results are server-rendered
// anchors with the title and description in data-slot elements.
export async function parseMwmblHtml(html: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let current: SearchResult | null = null;
  const rewriter = new HTMLRewriter()
    .on('a[class="group max-w-full"]', {
      element(el) {
        current = null;
        const href = el.getAttribute("href");
        if (href === null || !/^https?:\/\//.test(href)) return;
        current = { title: "", url: href, snippet: "", engine: "mwmbl" };
        results.push(current);
        el.onEndTag(() => {
          current = null;
        });
      },
    })
    .on('div[data-slot="card-title"]', {
      text(chunk) {
        if (current) current.title += chunk.text;
      },
    })
    .on('p[data-slot="card-description"]', {
      text(chunk) {
        if (current) current.snippet += chunk.text;
      },
    });
  const transformed: unknown = rewriter.transform(html);
  if (transformed instanceof Response) await transformed.text();
  return results
    .map((result) => ({
      ...result,
      title: collapse(decodeEntities(result.title)),
      snippet: collapse(decodeEntities(result.snippet)),
    }))
    .filter((result) => result.title !== "");
}

// Right Dao is an independent keyless index that renders its results as plain
// HTML and answers without a challenge, so it keeps working when DuckDuckGo
// cools down. Each result sits in an `item` block with a title anchor, a
// description and the display URL.
export function parseRightDaoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div class="item"/).slice(1);
  for (const block of blocks) {
    const href = /<div class="title"[^>]*>\s*<a[^>]*href="([^"]+)"/.exec(
      block,
    )?.[1];
    if (!href || !/^https?:\/\//.test(href)) continue;
    const titleHtml =
      /<div class="ellipsis-lg"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const snippetHtml =
      /<div class="description"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const title = collapse(decodeEntities(stripTags(titleHtml)));
    if (!title) continue;
    results.push({
      title,
      url: href,
      snippet: collapse(
        decodeEntities(
          stripTags(
            snippetHtml.replace(/<span class="date">[\s\S]*?<\/span>/, ""),
          ),
        ),
      ),
      engine: "rightdao",
    });
  }
  return results;
}

export function makeRightDaoEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "rightdao",
    minIntervalMs: 2_000,
    async search(query, num) {
      const url = `https://rightdao.com/search?q=${encodeURIComponent(query)}`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 2_000, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseRightDaoHtml(await res.text()).slice(0, num);
    },
  };
}

export const rightDaoEngine = makeRightDaoEngine();

export function makeMwmblEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "mwmbl",
    minIntervalMs: 2_500,
    async search(query, num) {
      const url = `https://mwmbl.org/search?q=${encodeURIComponent(query)}`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 2_500, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return (await parseMwmblHtml(await res.text())).slice(0, num);
    },
  };
}

export const mwmblEngine = makeMwmblEngine();

export function makeGithubEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "github",
    minIntervalMs: 6_100,
    async search(query, num) {
      const url =
        `https://api.github.com/search/repositories` +
        `?q=${encodeURIComponent(query)}&per_page=${num}`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 6_100, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseGithubJson(await res.json()).slice(0, num);
    },
  };
}

export function makeNpmEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "npm",
    minIntervalMs: 300,
    async search(query, num) {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${num}`;
      const res = await politeFetch(url, { minIntervalMs: 300 }, deps);
      if (res.status !== 200) return [];
      return parseNpmJson(await res.json()).slice(0, num);
    },
  };
}

// Scaffolding words that would poison a quoted arXiv phrase ("rate limiting"
// beats "rate limiting for").
const ARXIV_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "and",
  "or",
  "of",
  "in",
  "on",
  "to",
  "with",
  "how",
  "what",
  "why",
  "is",
  "are",
  "do",
  "does",
  "best",
  "vs",
  "using",
]);

export function makeArxivEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "arxiv",
    minIntervalMs: 3_000,
    async search(query, num) {
      // The head noun phrase is what arXiv matches best: quote the first two
      // content words as a phrase ("rate limiting"), drop scaffolding, and
      // stay unquoted for single-word queries.
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, ""))
        .filter((word) => word.length > 0 && !ARXIV_STOPWORDS.has(word));
      if (words.length === 0) return [];
      const phrase = words.slice(0, 2).join(" ");
      const term = words.length >= 2 ? `"${phrase}"` : phrase;
      const url =
        `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(term)}` +
        `&max_results=${num}`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 3_000, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseArxivXml(await res.text()).slice(0, num);
    },
  };
}

export function makeOpenAlexEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "openalex",
    minIntervalMs: 1_000,
    async search(query, num) {
      const url =
        `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${num}` +
        `&select=id,display_name,doi,publication_year,cited_by_count,primary_location`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 1_000, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseOpenAlexJson(await res.json()).slice(0, num);
    },
  };
}

export function makeNewsEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "news",
    minIntervalMs: 1_100,
    async search(query, num) {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 1_100, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseBingNewsRss(await res.text()).slice(0, num);
    },
  };
}

export function makeHnEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "hn",
    minIntervalMs: 300,
    async search(query, num) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${num}`;
      const res = await politeFetch(url, { minIntervalMs: 300 }, deps);
      if (res.status !== 200) return [];
      return parseHnJson(await res.json()).slice(0, num);
    },
  };
}

export function makeWikiEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "wiki",
    minIntervalMs: 300,
    async search(query, num) {
      const url =
        `https://en.wikipedia.org/w/api.php?action=query&list=search` +
        `&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${num}`;
      const res = await politeFetch(url, { minIntervalMs: 300 }, deps);
      if (res.status !== 200) return [];
      return parseWikiJson(await res.json()).slice(0, num);
    },
  };
}

export function makeMdnEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "mdn",
    minIntervalMs: 300,
    async search(query, num) {
      const url = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`;
      const res = await politeFetch(url, { minIntervalMs: 300 }, deps);
      if (res.status !== 200) return [];
      return parseMdnJson(await res.json()).slice(0, num);
    },
  };
}

export function makeStackoverflowEngine(deps: HttpDeps = {}): Engine {
  return {
    name: "stackoverflow",
    minIntervalMs: 1_100,
    async search(query, num) {
      const url =
        "https://api.stackexchange.com/2.3/search/advanced" +
        `?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${num}`;
      const res = await politeFetch(
        url,
        { minIntervalMs: 1_100, retries: 1 },
        deps,
      );
      if (res.status !== 200) return [];
      return parseStackExchangeJson(await res.json()).slice(0, num);
    },
  };
}

export const ddgEngine = makeDdgEngine();
export const braveEngine = makeBraveEngine();
export const bingEngine = makeBingEngine();
export const newsEngine = makeNewsEngine();
export const hnEngine = makeHnEngine();
export const wikiEngine = makeWikiEngine();
export const mdnEngine = makeMdnEngine();
export const stackoverflowEngine = makeStackoverflowEngine();
export const npmEngine = makeNpmEngine();
export const githubEngine = makeGithubEngine();
export const arxivEngine = makeArxivEngine();
export const openalexEngine = makeOpenAlexEngine();
