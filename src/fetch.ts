// Page fetching for LLM consumption: direct fetch with readable extraction,
// Wayback Machine fallback, and a 6-hour page cache with stale fallback.
import { cacheGet, cacheSet, type CacheDeps } from "./cache";
import { corpusAdd } from "./corpus";
import { decodeEntities } from "./engines";
import { isChallengeResponse, politeFetch, type HttpDeps } from "./http";
import type { FetchedPage, PageOptions } from "./types";

const CACHE_TTL_MS = 21_600_000;
const DEFAULT_MAX_CHARS = 20_000;
const WAYBACK_PREFIX = "https://web.archive.org/web/2id_/";
const NOISE_SELECTOR = "script, style, nav, footer, aside, form";
// Escaped structural markup that survives extraction as literal text (some
// sites ship fragments of their own DOM inside text nodes); whitelist-only
// so generic code text like "a < b" or "<T>" is never rewritten.
const STRUCTURAL_TAG =
  /<\/?(?:h[1-6]|ol|ul|li|a|div|span|p|em|strong|code|pre|table|thead|tbody|tr|td|th|br)\b[^>]*>/gi;
// Accessibility chrome that text handlers cannot see as markup.
const CHROME_PHRASE =
  /(?:Open|Close)\s+the\s+search\s+menu|Skip\s+to\s+(?:main\s+)?content|Enhanced\s+Page\s+Navigation/gi;

export interface FetchDeps extends HttpDeps, CacheDeps {}

interface StoredPage {
  at: number;
  page: FetchedPage;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Drop escaped structural tags and a11y chrome from decoded text. */
export function stripStructural(s: string): string {
  return s
    .replace(STRUCTURAL_TAG, "")
    .replace(CHROME_PHRASE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a parseable URL; there is no hostname to report.
    return "";
  }
}

function schemeOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    // Not a parseable URL; there is no scheme to check.
    return undefined;
  }
}

export async function extractReadable(
  html: string,
  url: string,
): Promise<{ title: string; text: string }> {
  let titleRaw = "";
  let bodyRaw = "";
  let mainRaw = "";
  let articleRaw = "";
  let docRaw = "";
  let noiseDepth = 0;

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        titleRaw += chunk.text;
      },
    })
    .on(NOISE_SELECTOR, {
      element(el) {
        noiseDepth += 1;
        el.remove();
        el.onEndTag(() => {
          noiseDepth -= 1;
        });
      },
    })
    .on("main", {
      text(chunk) {
        if (noiseDepth === 0) mainRaw += chunk.text;
      },
    })
    .on("article", {
      text(chunk) {
        if (noiseDepth === 0) articleRaw += chunk.text;
      },
    })
    .on("body", {
      text(chunk) {
        if (noiseDepth === 0) bodyRaw += chunk.text;
      },
    })
    .on("html", {
      text(chunk) {
        if (noiseDepth === 0) docRaw += chunk.text;
      },
    });

  // Bun's transform(string) runs the handlers synchronously and returns the
  // rewritten string; undici-style runtimes return a Response instead.
  const transformed: unknown = rewriter.transform(html);
  if (transformed instanceof Response) await transformed.text();

  // Band-aid the literal-markup leak first (Some sites escape their own DOM
  // into text nodes), then flatten: decode -> strip -> collapse is the order,
  // because the strip list matches tag shapes that only exist post-decode.
  const title =
    collapse(stripStructural(decodeEntities(titleRaw))) || hostOf(url);
  // Modern pages put chrome (skip links, nav, language pickers) outside the
  // semantic content container, so prefer the first non-empty of
  // main > article > body > document.
  const mainText = collapse(stripStructural(decodeEntities(mainRaw)));
  const articleText = collapse(stripStructural(decodeEntities(articleRaw)));
  const bodyText = collapse(stripStructural(decodeEntities(bodyRaw)));
  const docText = collapse(stripStructural(decodeEntities(docRaw)));
  const text =
    [mainText, articleText, bodyText, docText].find(
      (candidate) => candidate.length > 0,
    ) ?? "";
  return { title, text };
}

type Attempt =
  { ok: true; title: string; text: string } | { ok: false; reason: string };

function isHtmlResponse(contentType: string, raw: string): boolean {
  return /html/i.test(contentType) || /<html[\s>]|<!doctype html/i.test(raw);
}

function isTextContentType(contentType: string): boolean {
  if (contentType === "") return true;
  return /^text\//i.test(contentType) || /json|xml/i.test(contentType);
}

async function attempt(
  fetchUrl: string,
  via: "direct" | "wayback",
  deps: FetchDeps,
): Promise<Attempt> {
  try {
    const res = await politeFetch(
      fetchUrl,
      { retries: via === "direct" ? 1 : 0 },
      deps,
    );
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (isChallengeResponse(res.status, raw.slice(0, 4_000))) {
      return { ok: false, reason: `challenge response (HTTP ${res.status})` };
    }
    if (isHtmlResponse(contentType, raw)) {
      const { title, text } = await extractReadable(raw, fetchUrl);
      if (!text) return { ok: false, reason: "no readable text" };
      return { ok: true, title, text };
    }
    if (isTextContentType(contentType)) {
      const text = raw.trim();
      if (!text) return { ok: false, reason: "empty body" };
      return { ok: true, title: hostOf(fetchUrl), text };
    }
    return { ok: false, reason: `unsupported content-type "${contentType}"` };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function capPage(page: FetchedPage, maxChars: number): FetchedPage {
  const text = page.text.slice(0, maxChars);
  return { ...page, text, truncated: page.text.length > maxChars };
}

export async function fetchPage(
  url: string,
  opts: PageOptions = {},
  deps: FetchDeps = {},
): Promise<FetchedPage> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const scheme = schemeOf(url);
  if (scheme === undefined) {
    throw new Error(`invalid URL "${url}"`);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(
      `unsupported URL scheme "${scheme}" (only http and https are allowed)`,
    );
  }
  const now = deps.now ?? Date.now;
  // Bump when the extractor changes shape: stale page-cache entries written
  // by older extraction logic must not keep serving chrome-laden text.
  // v3: stripStructural cleanup (escaped DOM chrome in text nodes).
  const key = `fetch:v3:${url}`;

  let stale: FetchedPage | undefined;
  if (!opts.noCache) {
    // allowExpired read: a fresh entry short-circuits; an old one is kept as
    // the fallback candidate instead of being deleted by a strict read.
    const stored = await cacheGet<StoredPage>(key, true, deps);
    if (stored) {
      const page: FetchedPage = { ...stored.page, via: "cache" };
      if (now() - stored.at < CACHE_TTL_MS) return capPage(page, maxChars);
      stale = page;
    }
  }

  const direct = await attempt(url, "direct", deps);
  let page: FetchedPage | undefined;
  let reasons = `direct: ${direct.ok ? "" : direct.reason}`;
  if (direct.ok) {
    page = {
      url,
      title: direct.title,
      text: direct.text,
      via: "direct",
      truncated: false,
    };
  } else {
    const wayback = await attempt(WAYBACK_PREFIX + url, "wayback", deps);
    if (wayback.ok) {
      page = {
        url,
        title: wayback.title,
        text: wayback.text,
        via: "wayback",
        truncated: false,
      };
    } else {
      reasons += `; wayback: ${wayback.reason}`;
    }
  }

  if (page) {
    if (!opts.noCache) {
      await cacheSet(
        key,
        { at: now(), page } satisfies StoredPage,
        CACHE_TTL_MS,
        deps,
      );
    }
    // Compounding corpus: every fetched page becomes searchable locally.
    if (!process.env.QANY_NO_LEARN) {
      try {
        corpusAdd({ url, title: page.title, text: page.text }, deps);
      } catch (error) {
        console.error(
          `qany: corpus learn failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return capPage(page, maxChars);
  }

  if (stale) {
    console.error(`qany: serving stale page for ${url} (${reasons})`);
    return capPage(stale, maxChars);
  }
  throw new Error(`qany: could not fetch ${url} (${reasons})`);
}
