import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusAdd } from "../src/corpus";
import {
  docsFromCurated,
  docsFromInventory,
  docsFromLlms,
  docsFromRss,
  docsFromSitemap,
  expansionQuery,
  fuseResults,
  normalizeUrl,
  queryTokens,
  relevantEnough,
  search,
  type SearchDeps,
  topicQuery,
  variantsFor,
} from "../src/search";
import type { Engine, FetchedPage, SearchResult } from "../src/types";

class FakeClock {
  t = 1_000_000;
  now = () => this.t;
}

function freshDeps(): { deps: SearchDeps; clock: FakeClock } {
  const dir = mkdtempSync(join(tmpdir(), "qany-search-"));
  const clock = new FakeClock();
  // suggest: null keeps tests hermetic; the suggestion path has its own test
  // with a stubbed hook.
  return { deps: { dir, now: clock.now, suggest: null }, clock };
}

function hit(
  url: string,
  title = url,
  snippet = "",
  engine = "test",
): SearchResult {
  return { title, url, snippet, engine };
}

interface CountingEngine extends Engine {
  calls: number;
  queries: string[];
}

interface StubFetcher {
  fetcher: (url: string) => Promise<FetchedPage>;
  calls: string[];
}

function stubFetcher(pages: Record<string, string>): StubFetcher {
  const calls: string[] = [];
  return {
    calls,
    async fetcher(url: string) {
      calls.push(url);
      const text = pages[url];
      if (text === undefined) throw new Error(`no page for ${url}`);
      return {
        url,
        title: url,
        text,
        via: "direct" as const,
        truncated: false,
      };
    },
  };
}

function fakeEngine(
  name: string,
  impl: (query: string) => Promise<SearchResult[]>,
): CountingEngine {
  const engine: CountingEngine = {
    name,
    minIntervalMs: 0,
    calls: 0,
    queries: [] as string[],
    async search(query: string) {
      engine.calls += 1;
      engine.queries.push(query);
      return impl(query);
    },
  };
  return engine;
}

async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.error = original;
  }
}

describe("normalizeUrl", () => {
  test("strips www, case, and trailing slash", () => {
    expect(normalizeUrl("https://www.Example.com/")).toBe(
      normalizeUrl("https://example.com"),
    );
  });

  test("strips fragments", () => {
    expect(normalizeUrl("https://example.com/a#section")).toBe(
      normalizeUrl("https://example.com/a"),
    );
  });

  test("strips tracking params", () => {
    const dirty =
      "https://example.com/p?utm_source=x&utm_campaign=y&fbclid=1&gclid=2&sref=3&ref_src=4";
    expect(normalizeUrl(dirty)).toBe(normalizeUrl("https://example.com/p"));
  });

  test("keeps non-tracking params and sorts them", () => {
    expect(normalizeUrl("https://example.com/p?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/p?a=1&b=2"),
    );
    expect(normalizeUrl("https://example.com/p?page=2")).not.toBe(
      normalizeUrl("https://example.com/p"),
    );
  });

  test("passes invalid urls through unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("fuseResults", () => {
  test("raises a URL confirmed by two engines above any single-engine top hit", () => {
    const engineA = [hit("https://a.example/top", "A top")];
    const engineB = [
      hit("https://gold.example/x", "Gold"),
      hit("https://b.example/other", "B other"),
    ];
    const engineC = [hit("https://gold.example/x", "Gold dup")];
    const fused = fuseResults("zzz", [engineA, engineB, engineC]);
    expect(fused.map((r) => r.url)).toEqual([
      "https://gold.example/x",
      "https://a.example/top",
      "https://b.example/other",
    ]);
  });

  test("uses query relevance to break equal rank sums", () => {
    const generic = hit("https://weather.example/x", "Weather report", "");
    const specific = hit("https://news.example/tax", "Egypt 2025 tax law", "");
    const fused = fuseResults("egypt tax 2025", [[generic, specific]]);
    expect(fused.map((r) => r.url)).toEqual([
      "https://news.example/tax",
      "https://weather.example/x",
    ]);
  });

  test("counts plural query tokens against singular text", () => {
    const law = hit(
      "https://news.example/law",
      "New tax law passed in Egypt",
      "",
    );
    const none = hit("https://other.example/x", "Weather report", "");
    const fused = fuseResults("tax laws", [[none, law]]);
    expect(fused.map((r) => r.url)).toEqual([
      "https://news.example/law",
      "https://other.example/x",
    ]);
  });

  test("keeps engine order when one engine's ranking agrees with relevance", () => {
    const list = [
      hit("https://a.example/1", "Alpha one"),
      hit("https://b.example/2", "Alpha two"),
    ];
    const fused = fuseResults("alpha", [list]);
    expect(fused.map((r) => r.url)).toEqual([
      "https://a.example/1",
      "https://b.example/2",
    ]);
  });

  test("dedupes across engines and fills a missing snippet", () => {
    const ddg = [hit("https://x.example/x/", "X", "")];
    const bing = [hit("https://www.x.example/x", "X dup", "snippet from bing")];
    const fused = fuseResults("x", [ddg, bing]);
    expect(fused.length).toBe(1);
    expect(fused[0].title).toBe("X");
    expect(fused[0].snippet).toBe("snippet from bing");
  });

  test("merges every unique result without a cap", () => {
    const lists = [
      [hit("https://a.example/1"), hit("https://a.example/2")],
      [hit("https://b.example/1"), hit("https://b.example/2")],
      [hit("https://c.example/1"), hit("https://c.example/2")],
      [hit("https://d.example/1"), hit("https://d.example/2")],
    ];
    expect(fuseResults("zzz", lists).length).toBe(8);
  });

  test("freshness flips an exact fusion tie the way trust does", () => {
    const fresh = hit(
      "https://a.example/now",
      "Bun v1.4.3 released October 10, 2026",
      "",
    );
    const stale = hit(
      "https://b.example/then",
      "Bun v1.4.3 released September 5, 2026",
      "",
    );
    // Same engine votes in mirror order: RRF sums and relevance are exact ties.
    const lists = [
      [stale, fresh],
      [fresh, stale],
    ];
    const now = new Date("2026-10-20T12:00:00Z");
    expect(
      fuseResults("bun release", lists, undefined, undefined, now).map(
        (r) => r.url,
      ),
    ).toEqual(["https://a.example/now", "https://b.example/then"]);
  });
});

describe("queryTokens", () => {
  test("drops stopwords, short tokens, and punctuation", () => {
    expect(queryTokens("What are the tax laws for Egypt, 2025?")).toEqual([
      "what",
      "tax",
      "laws",
      "egypt",
      "2025",
    ]);
  });
});

describe("variantsFor", () => {
  test("short head drops generic verbs so lexical engines see the topic", () => {
    const variants = variantsFor("how does postgres implement mvcc");
    expect(variants).toContain("postgres mvcc");
    const ws = variantsFor(
      "how do i implement websocket reconnect with exponential backoff in javascript",
    );
    expect(ws).toContain("websocket reconnect exponential backoff");
  });

  test("how-to questions get a guide angle", () => {
    const variants = variantsFor(
      "how do i implement websocket reconnect with exponential backoff in javascript",
    );
    expect(variants.some((variant) => variant.endsWith("guide"))).toBe(true);
    expect(variants.some((variant) => variant.endsWith("explained"))).toBe(
      false,
    );
  });

  test("non-how-to questions keep the explained and internals angles", () => {
    expect(
      variantsFor("when should i use a semaphore").some((variant) =>
        variant.endsWith("explained"),
      ),
    ).toBe(true);
    expect(
      variantsFor(
        "why does my async iterator work under the hood and not the sync iterator",
      ).some((variant) => variant.endsWith("internals")),
    ).toBe(true);
  });

  test("adds a title variant for question queries", () => {
    const query = "How do async iterators work under the hood in JavaScript";
    const variants = variantsFor(query);
    expect(variants.length).toBe(3);
    expect(variants[0]).toBe(query);
    expect(variants[1]).toBe("async iterators javascript");
    expect(variants[2]).toBe("async iterators javascript internals");
  });

  test("uses a phrase window when the question holds a long content run", () => {
    const variants = variantsFor(
      "how to measure cold bootstrap memory in agent runtimes",
    );
    expect(variants.length).toBe(3);
    expect(variants[2]).toBe('"cold bootstrap memory"');
  });

  test("keeps keyword queries at one variant", () => {
    expect(variantsFor("egypt tax laws 2025")).toEqual(["egypt tax laws 2025"]);
    expect(variantsFor("async iterators")).toEqual(["async iterators"]);
  });

  test("prefers the phrase window over the title suffix when both fit", () => {
    const variants = variantsFor(
      "how does the event loop microtask queue drain in node",
    );
    expect(variants[2]).toBe('"microtask queue drain"');
  });

  test("caps variants at three and dedupes", () => {
    const variants = variantsFor(
      "why does my async iterator work under the hood and not the sync iterator",
    );
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.length).toBeLessThanOrEqual(3);
  });
});

describe("topicQuery", () => {
  test("strips question scaffolding from a full question", () => {
    expect(
      topicQuery("How do async iterators work under the hood in JavaScript"),
    ).toBe("async iterators work under hood in javascript");
  });

  test("strips auxiliaries from a why question", () => {
    expect(topicQuery("Why is Node single threaded?")).toBe(
      "node single threaded",
    );
  });

  test("keeps comparison words from an is question", () => {
    expect(topicQuery("Is bun faster than node")).toBe("bun faster than node");
  });

  test("keeps syntax phrases and language markers", () => {
    expect(topicQuery("How to use for await of in JavaScript")).toBe(
      "use for await of in javascript",
    );
  });

  test("bails on code punctuation", () => {
    expect(topicQuery("How do I use Symbol.asyncIterator in JS")).toBe(null);
    expect(topicQuery('What does "use strict" do in js?')).toBe(null);
  });

  test("bails on non-question queries", () => {
    expect(topicQuery("bun typescript runtime")).toBe(null);
    expect(topicQuery("async iterators")).toBe(null);
  });

  test("bails when stripping leaves too little", () => {
    expect(topicQuery("How does it work?")).toBe(null);
    expect(topicQuery("Why?")).toBe(null);
  });
});

describe("relevantEnough", () => {
  test("rejects a set with zero query-token overlap in the top 3", () => {
    const junk = [
      hit("https://spam.example/1", "Cheap flights"),
      hit("https://spam.example/2", "More ads"),
    ];
    expect(relevantEnough("bun runtime", junk)).toBe(false);
  });

  test("keeps a set where any of the top 3 overlaps", () => {
    const good = [
      hit("https://bun.com/docs", "Bun docs"),
      hit("https://other.example/x", "Other"),
    ];
    expect(relevantEnough("bun runtime", good)).toBe(true);
  });

  test("ignores tokens shorter than 3 chars", () => {
    expect(relevantEnough("a b", [hit("https://spam.example/x", "Spam")])).toBe(
      true,
    );
  });

  test("keeps an empty set", () => {
    expect(relevantEnough("bun runtime", [])).toBe(true);
  });

  test("only inspects the top 3", () => {
    const offTop = [
      hit("https://a.example/1", "One"),
      hit("https://a.example/2", "Two"),
      hit("https://a.example/3", "Three"),
      hit("https://bun.com/deep", "Bun docs"),
    ];
    expect(relevantEnough("bun runtime", offTop)).toBe(false);
  });
});

describe("search", () => {
  test("returns results from healthy engines when one rejects", async () => {
    const bad = fakeEngine("bad", async () => {
      throw new Error("boom");
    });
    const good = fakeEngine("good", async () => [
      hit("https://bun.com/", "Bun"),
    ]);
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search("bun runtime", { engines: [bad, good] }, deps),
    );
    expect(result.map((r) => r.url)).toEqual(["https://bun.com/"]);
    expect(logs.some((l) => l.includes("bad"))).toBe(true);
  });

  test("throws mentioning the query when every engine rejects and no cache exists", async () => {
    const e1 = fakeEngine("e1", async () => {
      throw new Error("down");
    });
    const { deps } = freshDeps();
    const attempt = captureStderr(() =>
      search("bun runtime", { engines: [e1] }, deps),
    );
    await expect(attempt).rejects.toThrow("bun runtime");
  });

  test("serves a second identical call from cache without hitting engines", async () => {
    const eng = fakeEngine("cached", async () => [
      hit("https://bun.com/", "Bun"),
    ]);
    const { deps } = freshDeps();
    const first = await search("bun runtime", { engines: [eng] }, deps);
    const second = await search("bun runtime", { engines: [eng] }, deps);
    expect(second).toEqual(first);
    expect(eng.calls).toBe(1);
  });

  test("falls back to a stale cache entry when engines return nothing", async () => {
    const { deps, clock } = freshDeps();
    let results: SearchResult[] = [hit("https://bun.com/stale", "Stale Bun")];
    const eng = fakeEngine("flaky", async () => results);
    await search("bun runtime", { engines: [eng] }, { ...deps, suggest: null });
    clock.t += 700_000;
    results = [];
    const { result: out } = await captureStderr(() =>
      search("bun runtime", { engines: [eng] }, { ...deps, suggest: null }),
    );
    expect(out).toEqual([hit("https://bun.com/stale", "Stale Bun")]);
    expect(eng.calls).toBe(2);
  });

  test("ranks specific results above generic ones across engines", async () => {
    const wikiish = fakeEngine("wikiish", async () => [
      hit(
        "https://en.wikipedia.org/wiki/Egypt",
        "Egypt",
        "Egypt is a country in Africa.",
      ),
      hit(
        "https://en.wikipedia.org/wiki/History_of_Egypt",
        "History of Egypt",
        "An ancient civilization.",
      ),
    ]);
    const newsish = fakeEngine("newsish", async () => [
      hit(
        "https://news.example/tax",
        "Egypt 2025 tax law deadline is 12 August",
        "The Egyptian Tax Authority confirmed the deadline.",
      ),
    ]);
    const { deps } = freshDeps();
    const out = await search(
      "egypt tax laws 2025",
      { engines: [wikiish, newsish] },
      deps,
    );
    expect(out[0]!.url).toBe("https://news.example/tax");
  });

  test("slices ranked results to num", async () => {
    const eng = fakeEngine("many", async () => [
      hit("https://x.example/1", "Bun one"),
      hit("https://x.example/2", "Bun two"),
      hit("https://x.example/3", "Bun three"),
    ]);
    const { deps } = freshDeps();
    const out = await search("bun", { engines: [eng], num: 2 }, deps);
    expect(out.length).toBe(2);
  });

  test("caches empty results with a short ttl", async () => {
    const eng = fakeEngine("empty", async () => []);
    const { deps, clock } = freshDeps();
    expect(
      await search(
        "zzz nothing",
        { engines: [eng] },
        { ...deps, suggest: null },
      ),
    ).toEqual([]);
    expect(
      await search(
        "zzz nothing",
        { engines: [eng] },
        { ...deps, suggest: null },
      ),
    ).toEqual([]);
    expect(eng.calls).toBe(1);
    clock.t += 180_001;
    await search("zzz nothing", { engines: [eng] }, { ...deps, suggest: null });
    expect(eng.calls).toBe(2);
  });

  test("drops an engine set with zero overlap with the query", async () => {
    const noise = fakeEngine("noise", async () => [
      hit("https://spam.example/x", "Cheap flights"),
    ]);
    const good = fakeEngine("good", async () => [
      hit("https://bun.com/", "Bun runtime"),
    ]);
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search("bun runtime", { engines: [noise, good] }, deps),
    );
    expect(result.map((r) => r.url)).toEqual(["https://bun.com/"]);
    expect(logs.some((l) => l.includes("noise"))).toBe(true);
  });

  test("noCache skips both read and write", async () => {
    const eng = fakeEngine("nocache", async () => [
      hit("https://bun.com/", "Bun"),
    ]);
    const { deps } = freshDeps();
    await search("bun runtime", { engines: [eng], noCache: true }, deps);
    await search("bun runtime", { engines: [eng], noCache: true }, deps);
    expect(eng.calls).toBe(2);
  });

  test("returns an empty list when engines have no results and no cache exists", async () => {
    const eng = fakeEngine("empty", async () => []);
    const { deps } = freshDeps();
    expect(
      await search("zzz", { engines: [eng] }, { ...deps, suggest: null }),
    ).toEqual([]);
  });

  test("general web engines get one query per search, the short head", async () => {
    const duck = fakeEngine("duckduckgo", async () => [
      hit("https://duck.example/x", "Duck"),
    ]);
    const mdn = fakeEngine("mdn", async () => [
      hit("https://developer.mozilla.org/x", "MDN"),
    ]);
    const { deps } = freshDeps();
    await captureStderr(() =>
      search(
        "How do async iterators work in JavaScript",
        { engines: [duck, mdn] },
        { ...deps, suggest: null },
      ),
    );
    expect(duck.queries).toEqual(["async iterators javascript"]);
    expect(mdn.queries).toEqual([
      "How do async iterators work in JavaScript",
      "async iterators javascript",
      "async iterators javascript guide",
    ]);
  });

  test("runs the topic and title variants on variant engines for question queries", async () => {
    const mdn = fakeEngine("mdn", async () => [
      hit("https://developer.mozilla.org/x", "MDN"),
    ]);
    const { deps } = freshDeps();
    await search(
      "How do async iterators work in JavaScript",
      { engines: [mdn] },
      { ...deps, suggest: null },
    );
    expect(mdn.queries).toEqual([
      "How do async iterators work in JavaScript",
      "async iterators javascript",
      "async iterators javascript guide",
    ]);
  });

  test("runs raw only on non-variant engines and non-question queries", async () => {
    const wiki = fakeEngine("wiki", async () => []);
    const hn = fakeEngine("hn", async () => []);
    const { deps } = freshDeps();
    await search(
      "bun typescript runtime",
      { engines: [wiki, hn] },
      { ...deps, suggest: null },
    );
    expect(wiki.queries).toEqual(["bun typescript runtime"]);
    expect(hn.queries).toEqual(["bun typescript runtime"]);
  });

  test("guards variant sets against the query that produced them", async () => {
    // The variant query carries words the raw query lacks ("explained"); a set
    // matching only the variant must survive the guard.
    const mdn = fakeEngine("mdn", async (query) =>
      query.includes("guide")
        ? [hit("https://blog.example/explained", "Async iterators explained")]
        : [],
    );
    const { deps } = freshDeps();
    const out = await search(
      "How do async iterators work in JavaScript",
      { engines: [mdn] },
      deps,
    );
    expect(out.map((r) => r.url)).toEqual(["https://blog.example/explained"]);
  });

  test("corpus pages rank even when every engine returns nothing", async () => {
    const { deps } = freshDeps();
    const filler =
      "the async iterator protocol drains promises from a queue with next calls. ".repeat(
        10,
      );
    corpusAdd(
      {
        url: "https://corpus.example/async",
        title: "Async iterators explained",
        text: filler,
      },
      deps,
    );
    const eng = fakeEngine("hn", async () => []);
    const out = await search(
      "How do async iterators work",
      { engines: [eng] },
      deps,
    );
    expect(out[0]!.url).toBe("https://corpus.example/async");
    expect(out[0]!.engine).toBe("corpus");
  });

  test("fuses the topic list into the ranking", async () => {
    const mdn = fakeEngine("mdn", async (query) =>
      query === "How do async iterators work in JavaScript"
        ? [hit("https://blog.example/roundup", "Async iterators roundup")]
        : [
            hit(
              "https://developer.mozilla.org/AsyncIterator",
              "MDN AsyncIterator",
            ),
          ],
    );
    const { deps } = freshDeps();
    const out = await search(
      "How do async iterators work in JavaScript",
      { engines: [mdn] },
      deps,
    );
    expect(out.map((r) => r.url)).toEqual([
      "https://developer.mozilla.org/AsyncIterator",
      "https://blog.example/roundup",
    ]);
  });

  test("promotes results whose page text carries the evidence", async () => {
    const eng = fakeEngine("default", async () => [
      hit(
        "https://weather.example/x",
        "Weather roundup",
        "roundup of weather items",
      ),
      hit(
        "https://docs.example/async",
        "Async iterators guide",
        "a small guide",
      ),
    ]);
    const { fetcher, calls } = stubFetcher({
      "https://weather.example/x": "Weather report for cities.",
      "https://docs.example/async":
        "Async iterators let you await each item. They work in javascript runtimes.",
    });
    const { deps } = freshDeps();
    const out = await search(
      "How do async iterators work in javascript",
      {
        engines: [eng],
        num: 2,
        rerank: true,
        pageFetcher: fetcher,
      },
      deps,
    );
    expect(out.map((r) => r.url)).toEqual([
      "https://docs.example/async",
      "https://weather.example/x",
    ]);
    expect([...calls].sort()).toEqual(
      ["https://weather.example/x", "https://docs.example/async"].sort(),
    );
  });

  test("keeps the fused order when page fetches fail", async () => {
    const eng = fakeEngine("default", async () => [
      hit("https://first.example/lead", "Async iterators lead", "l"),
      hit("https://second.example/trailing", "Trailing async iterators", "t"),
    ]);
    const { fetcher, calls } = stubFetcher({});
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "How do async iterators work in javascript",
        {
          engines: [eng],
          rerank: true,
          pageFetcher: fetcher,
        },
        deps,
      ),
    );
    expect(result.map((r) => r.url)).toEqual([
      "https://first.example/lead",
      "https://second.example/trailing",
    ]);
    expect(calls.length).toBe(2);
  });

  test("fetches at most the top 6 candidates", async () => {
    const eng = fakeEngine("default", async () =>
      Array.from({ length: 8 }, (_, i) =>
        hit(`https://x.example/${i + 1}`, `Async iterators item ${i + 1}`),
      ),
    );
    const { fetcher, calls } = stubFetcher({});
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "How do async iterators work in javascript",
        {
          engines: [eng],
          rerank: true,
          pageFetcher: fetcher,
        },
        deps,
      ),
    );
    expect(calls.length).toBe(6);
    expect(result.length).toBe(8);
  });

  test("skips rerank for keyword queries", async () => {
    const eng = fakeEngine("default", async () => [
      hit("https://docs.example/async", "async iterators"),
    ]);
    const { fetcher, calls } = stubFetcher({});
    const { deps } = freshDeps();
    await search(
      "bun typescript runtime",
      { engines: [eng], rerank: true, pageFetcher: fetcher },
      deps,
    );
    expect(calls).toEqual([]);
  });

  test("rerank keeps scattered pages below dense ones", async () => {
    // Every query token appears twice, but token families sit ~1000 chars
    // (13 filler paragraphs) apart, so no window can hold two families;
    // page B holds all three tokens in a single short paragraph.
    const fillerLine =
      "Filler sentences about moody rows silence crips under warm cannon noise.";
    const hitLines = [
      "Quiet commentary mentions async alone briefly tonight alongside rivers.",
      "Iterator words idle elsewhere while plumbing maintains candles for bakers.",
      "The protocol maps survive under moody backups for the barrel.",
    ];
    const parts: string[] = [];
    for (let round = 0; round < 2; round++) {
      for (const line of hitLines) {
        parts.push(line);
        for (let pad = 0; pad < 13; pad++) parts.push(fillerLine);
      }
    }
    const scattered = parts.join("\n\n");
    const dense =
      "Async iterators drain promise queues; the iterator protocol awaits each result as the queue gives it up.";
    const eng = fakeEngine("default", async () => [
      hit(
        "https://a.example/scattered",
        "Async iterator deep guide",
        "scattered commentary only",
      ),
      hit(
        "https://b.example/dense",
        "Async iterator deep guide",
        "dense commentary here",
      ),
    ]);
    const { fetcher } = stubFetcher({
      "https://a.example/scattered": scattered,
      "https://b.example/dense": dense,
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "async iterator protocol",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        deps,
      ),
    );
    expect(result[0]!.url).toBe("https://b.example/dense");
    expect(result[1]!.url).toBe("https://a.example/scattered");
  });

  test("evidence must cover the query's content words, not just a generic verb", async () => {
    const eng = fakeEngine("default", async () => [
      hit(
        "https://postgres.example/cube",
        "Postgres implement CUBE operators",
        "postgres operators",
      ),
      hit("https://docs.example/visibility", "MVCC explained", ""),
    ]);
    const { fetcher } = stubFetcher({
      "https://postgres.example/cube":
        "postgres implement postgres implement postgres implement cubes rollup grouping sets",
      "https://docs.example/visibility":
        "postgres mvcc postgres mvcc visibility",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how does postgres implement mvcc",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(result[0]!.url).toBe("https://docs.example/visibility");
  });

  test("verified pages carry the answering paragraph as their snippet", async () => {
    const page =
      "Ambient chatter about everything except the request.\n\n" +
      "Async iterators promise queue drains: the iterator protocol awaits each result as it arrives.\n\n" +
      "Closing chatter that mentions none of the request words again.";
    const eng = fakeEngine("default", async () => [
      hit(
        "https://p.example/async",
        "Async iterators page",
        "engine snippet text",
      ),
      hit(
        "https://p.example/other",
        "Async iterators elsewhere",
        "no lift here",
      ),
    ]);
    const { fetcher } = stubFetcher({ "https://p.example/async": page });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "How do async iterators work in javascript",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        deps,
      ),
    );
    expect(result[0]!.snippet).toContain("queue drains");
    expect(result[0]!.snippet).not.toContain("engine snippet");
  });
});

describe("vocabulary expansion", () => {
  test("keyword queries with known aliases run an enriched variant", async () => {
    const queries: string[] = [];
    const eng = fakeEngine("duckduckgo", async (q) => {
      queries.push(q);
      return q.includes("throttling") && q.includes("rate limiting")
        ? [
            hit(
              "https://v.example/rate",
              "Rate limiting guide",
              "throttling strategies",
            ),
          ]
        : [];
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search("api throttling", { engines: [eng] }, deps),
    );
    expect(queries).toContain("api throttling rate limiting");
    expect(result[0]!.url).toBe("https://v.example/rate");
  });

  test("query terms already present in the enriched form do not duplicate variants", async () => {
    const queries: string[] = [];
    const eng = fakeEngine("default", async (q) => {
      queries.push(q);
      return [];
    });
    const { deps } = freshDeps();
    await captureStderr(() =>
      search("javascript generators", { engines: [eng] }, deps),
    );
    expect(queries.filter((q) => q === "javascript generators").length).toBe(1);
  });

  test("empty results retry once with the ddg suggestion", async () => {
    const eng = fakeEngine("default", async (q) =>
      q.includes("throttling")
        ? [hit("https://s.example/fixed", "Throttling guide", "fixed")]
        : [],
    );
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search(
        "throtling api",
        { engines: [eng] },
        {
          ...deps,
          suggest: async (q) =>
            q.includes("throtling") ? "throttling api" : null,
        },
      ),
    );
    expect(result[0]!.url).toBe("https://s.example/fixed");
    expect(logs.some((line) => line.includes("throttling api"))).toBe(true);
  });

  test("no suggestion keeps the empty result path", async () => {
    const eng = fakeEngine("default", async () => []);
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search(
        "zzqq xkcd",
        { engines: [eng] },
        { ...deps, suggest: async () => null },
      ),
    );
    expect(result).toEqual([]);
    expect(logs.some((line) => line.includes("suggestion"))).toBe(false);
  });

  test("one engine votes once even when several of its variants return results", async () => {
    // mdn answers both the raw query and the alias-enriched variant with the
    // same page p; wiki returns q once. Without per-engine merging p collects
    // two RRF votes and outranks the more relevant q; with merging the
    // relevance list decides, which is the designed consensus behavior.
    const p = hit("https://p.example/one", "Rate notes", "x");
    const q = hit(
      "https://q.example/two",
      "Rate limiting strategies",
      "rate limiting strategies",
    );
    const mdn = fakeEngine("mdn", async () => [p]);
    const wiki = fakeEngine("wiki", async () => [q]);
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "rate limiting",
        { engines: [mdn, wiki] },
        { ...deps, suggest: null },
      ),
    );
    expect(result.map((r) => r.url)).toEqual([
      "https://q.example/two",
      "https://p.example/one",
    ]);
  });
});

describe("pseudo-relevance expansion", () => {
  test("mines morphological siblings from strong pages", () => {
    const pool = [
      {
        title: "AsyncIterator - JavaScript | MDN",
        text: "The async iterator protocol: iteration over values, Symbol.asyncIterator, prototype methods, iterator.",
      },
      {
        title: "Async iteration and generators",
        text: "Async iteration works with generators. The iteration protocol awaits each result.",
      },
    ];
    const q = expansionQuery("how do async iterators work in javascript", pool);
    expect(q).not.toBeNull();
    expect(q!).toContain("iteration");
    expect(q!.startsWith("async iterators")).toBe(true);
    expect(q!).not.toContain("generators");
    expect(q!).not.toContain("asynciterator");
    expect(q!).not.toContain("iterator.");
  });

  test("body terms need two-page consensus and chrome is filtered", () => {
    const pool = [
      {
        title: "Guide one",
        text: "fullscreen mode iteration iteration iteration",
      },
      { title: "Guide two", text: "iteration again, iteration" },
    ];
    const q = expansionQuery("iterators deep dive", pool);
    expect(q).not.toBeNull();
    expect(q!).toContain("iteration");
    expect(q!).not.toContain("fullscreen");
  });

  test("plural and singular forms count as one term for consensus", () => {
    const pool = [
      {
        title: "Guide one",
        text: "The iteration story: iteration loops everywhere.",
      },
      { title: "Guide two", text: "More iterations of the same loop." },
    ];
    const q = expansionQuery("iterators deep dive", pool);
    expect(q).not.toBeNull();
    expect(q!).toContain("iteration");
  });

  test("returns null when nothing novel qualifies", () => {
    expect(
      expansionQuery("async iterators", [
        {
          title: "Async iterators",
          text: "async iterators async iterators async iterators",
        },
      ]),
    ).toBeNull();
  });

  test("expansion ignores compound fragments and non-family endings", () => {
    const pool = [
      {
        title: "Structured clone notes",
        text: "structuredclone handles structure and objective tradeoffs; the structure of objectives.",
      },
      {
        title: "More clone notes",
        text: "structure and objective appear here too, structuredclone again.",
      },
    ];
    expect(
      expansionQuery("how does structuredclone handle nested objects", pool),
    ).toBeNull();
  });

  test("the expansion wave searches again and its hits join the final list", async () => {
    const eng = fakeEngine("github", async (query) =>
      query.includes("iteration")
        ? [
            hit(
              "https://github.com/tc39/proposal-async-iteration",
              "tc39/proposal-async-iteration",
              "Async iteration proposal",
            ),
            hit(
              "https://github.com/tc39/async-spec",
              "tc39 async spec site",
              "The async iteration specification",
            ),
          ]
        : [
            hit(
              "https://github.com/other/async-iterators",
              "other async iterators repo",
              "about async iterators",
            ),
            hit(
              "https://github.com/other/async-two",
              "async iterators again",
              "async iterators again",
            ),
          ],
    );
    const { fetcher } = stubFetcher({
      "https://github.com/other/async-iterators":
        "Async iteration is the topic: iteration over iterators, iteration everywhere.",
      "https://github.com/other/async-two":
        "More on async iteration and the iteration protocol.",
      "https://github.com/tc39/proposal-async-iteration":
        "Async iteration proposal for JavaScript iterators.",
      "https://github.com/tc39/async-spec":
        "The specification for async iteration.",
    });
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(logs.some((line) => line.includes("expansion wave"))).toBe(true);
    expect(result.map((r) => r.url)).toContain(
      "https://github.com/tc39/proposal-async-iteration",
    );
  });

  test("question scaffolding words do not count as evidence", async () => {
    const eng = fakeEngine("default", async () => [
      hit("https://x.example/how", "How does the Internet work?", "how work"),
      hit("https://x.example/async", "Async iterators", "async iterators"),
    ]);
    const { fetcher } = stubFetcher({
      "https://x.example/how":
        "How does the Internet work? The internet works with how and work.",
      "https://x.example/async":
        "Async iterators drain queues. async iterators await results.",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "How do async iterators work in javascript",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        deps,
      ),
    );
    expect(result[0]!.url).toBe("https://x.example/async");
  });

  test("a wave hit that verifies its page evidence leads the final list", async () => {
    const mdnItems = Array.from({ length: 6 }, (_, i) =>
      hit(`https://mdn.example/page-${i}`, `async iterators guide ${i}`, ""),
    );
    const engMdn = fakeEngine("mdn", async () => mdnItems);
    const engGithub = fakeEngine("github", async (query) =>
      query.includes("iteration")
        ? [
            hit(
              "https://github.com/tc39/proposal-async-iteration",
              "tc39/proposal-async-iteration",
              "the async iteration proposal",
            ),
            hit(
              "https://github.com/other/noise",
              "other noise repo",
              "unrelated",
            ),
          ]
        : [
            hit(
              "https://github.com/other/async-repo",
              "async iterators repo",
              "async iterators",
            ),
            hit(
              "https://github.com/other/async-two",
              "async iterators two",
              "async iterators",
            ),
          ],
    );
    const { fetcher } = stubFetcher({
      "https://mdn.example/page-0": "async iterators iteration notes",
      "https://mdn.example/page-1": "async iterators iteration notes",
      "https://mdn.example/page-2": "async iterators notes",
      "https://mdn.example/page-3": "async iterators notes",
      "https://mdn.example/page-4": "async iterators notes",
      "https://mdn.example/page-5": "async iterators notes",
      "https://github.com/other/async-repo": "async iterators notes",
      "https://github.com/other/async-two": "async iterators notes",
      "https://github.com/tc39/proposal-async-iteration":
        "async iterators iteration async iterators iteration async iterators iteration",
      "https://github.com/other/noise": "unrelated content",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [engMdn, engGithub], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    // The mdn pages carry more raw evidence; the wave hit that verifies must lead.
    expect(result[0]!.url).toBe(
      "https://github.com/tc39/proposal-async-iteration",
    );
  });

  test("no expansion wave without rerank-eligible fetches", async () => {
    const eng = fakeEngine("github", async () => [
      hit(
        "https://github.com/a/async",
        "async iterators guide",
        "async iterators",
      ),
    ]);
    const { deps } = freshDeps();
    const { result, logs } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [eng] },
        { ...deps, suggest: null },
      ),
    );
    expect(logs.some((line) => line.includes("expansion wave"))).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("intent weighting", () => {
  test("news intent ranks the news list above academic and wiki lists", async () => {
    const newsItem = hit(
      "https://dailynewsegypt.example/x",
      "Egypt approves tax law changes",
      "the new tax law",
    );
    const paper = hit(
      "https://doi.example/10.1",
      "Deductible costs under tax law",
      "tax law analysis",
    );
    const wikiItem = hit(
      "https://en.wikipedia.example/Taxation_in_Egypt",
      "Egypt tax laws 2025",
      "tax law",
    );
    const engNews = fakeEngine("news", async () => [newsItem]);
    const engPaper = fakeEngine("openalex", async () => [paper]);
    const engWiki = fakeEngine("wiki", async () => [wikiItem]);
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "egypt tax laws 2025",
        { engines: [engWiki, engPaper, engNews] },
        deps,
      ),
    );
    expect(result[0]!.url).toBe(newsItem.url);
    expect(result[result.length - 1]!.url).toBe(paper.url);
  });

  test("dev intent ranks the repo list above the paper list", async () => {
    const repo = hit(
      "https://github.example/tc39/proposal-async-iteration",
      "tc39/proposal-async-iteration",
      "async iteration proposal",
    );
    const paper = hit(
      "https://arxiv.example/abs/1",
      "Async iterators in distributed systems",
      "async iterators paper",
    );
    const engGithub = fakeEngine("github", async () => [repo]);
    const engArxiv = fakeEngine("arxiv", async () => [paper]);
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [engArxiv, engGithub] },
        deps,
      ),
    );
    expect(result[0]!.url).toBe(repo.url);
  });

  test("official domains get a small authority boost", () => {
    const gov = hit("https://eta.gov.eg/en/laws", "Income tax laws", "");
    const news = hit(
      "https://dailynewsegypt.example/tax",
      "Income tax laws 2025",
      "",
    );
    const fused = fuseResults("income tax laws", [[news], [gov]]);
    expect(fused[0]!.url).toBe(gov.url);

    const fakeGov = hit(
      "https://government-portal.example/x",
      "Income tax laws",
      "",
    );
    const fused2 = fuseResults("income tax laws", [[news], [fakeGov]]);
    expect(fused2[0]!.url).toBe(news.url);

    const eu = hit("https://ec.europa.eu/ai-act", "AI Act enforcement", "");
    const euNews = hit(
      "https://euractiv.example/ai-act-2026",
      "AI Act enforcement 2026",
      "",
    );
    const fused3 = fuseResults("ai act enforcement", [[euNews], [eu]]);
    expect(fused3[0]!.url).toBe(eu.url);
  });

  test("news queries ask the news engine for official sources", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (q) => {
      queries.push(q);
      return [
        hit("https://news.example/x", "Egypt tax law update 2025", "tax"),
      ];
    });
    const { deps } = freshDeps();
    await captureStderr(() =>
      search("egypt tax laws 2025", { engines: [engNews] }, deps),
    );
    expect(
      queries.some(
        (q) =>
          q.includes("site:gov") &&
          q.includes("site:europa.eu") &&
          q.includes("site:who.int"),
      ),
    ).toBe(true);
  });

  test("dev queries do not ask for official sources", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (q) => {
      queries.push(q);
      return [hit("https://news.example/y", "async iterators guide", "async")];
    });
    const { deps } = freshDeps();
    await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [engNews] },
        deps,
      ),
    );
    expect(queries.some((q) => q.includes("site:"))).toBe(false);
  });

  test("official-source results must still match the topic", async () => {
    const engNews = fakeEngine("news", async (q) =>
      q.includes("site:")
        ? [
            hit(
              "https://justice.gov/opa/pr/x",
              "Justice Department announces filing",
              "",
            ),
          ]
        : [
            hit(
              "https://dailynews.example/x",
              "Egypt tax law update 2025",
              "tax",
            ),
          ],
    );
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search("egypt tax laws 2025", { engines: [engNews] }, deps),
    );
    expect(result.map((r) => r.url)).not.toContain(
      "https://justice.gov/opa/pr/x",
    );
    expect(result.map((r) => r.url)).toContain("https://dailynews.example/x");
  });

  test("official sources are not re-fetched when the pool already has them", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (q) => {
      queries.push(q);
      return [
        hit("https://sis.gov.eg/en/x", "Egypt tax law update 2025", "tax"),
      ];
    });
    const { deps } = freshDeps();
    await captureStderr(() =>
      search("egypt tax laws 2025", { engines: [engNews] }, deps),
    );
    expect(queries.some((q) => q.includes("site:"))).toBe(false);
  });

  test("docs sitemaps turn into canonical doc candidates", () => {
    const xml = [
      "<urlset>",
      "<url><loc>https://www.postgresql.org/about/</loc></url>",
      "<url><loc>https://www.postgresql.org/docs/19/mvcc.html</loc></url>",
      "<url><loc>https://www.postgresql.org/docs/current/mvcc-intro.html</loc></url>",
      "</urlset>",
    ].join("");
    const docs = docsFromSitemap(xml, ["mvcc"], 3);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]!.url).toBe(
      "https://www.postgresql.org/docs/current/mvcc-intro.html",
    );
    expect(docs.some((doc) => doc.url.includes("/about/"))).toBe(false);
  });

  test("llms indexes turn into canonical docs with titles", () => {
    const text = [
      "# Docs",
      "- [Queueing a Series of State Updates](https://react.dev/learn/queueing-a-series-of-state-updates.md): batching",
      "- [useState](https://react.dev/reference/react/useState.md)",
      "- [Blog](https://react.dev/blog/2023/05/03/react-canaries.md)",
    ].join("\n");
    const docs = docsFromLlms(text, ["state", "updates"], 5);
    expect(docs[0]!.url).toBe(
      "https://react.dev/learn/queueing-a-series-of-state-updates",
    );
    expect(docs[0]!.title).toBe("Queueing a Series of State Updates");
    expect(docs.every((doc) => !doc.url.endsWith(".md"))).toBe(true);
  });

  test("sphinx inventories turn API objects into doc anchors", () => {
    const text = [
      "asyncio.gather py:function 1 library/asyncio-task.html#$ -",
      "asyncio.sleep py:function 1 library/asyncio-task.html#asyncio.sleep -",
      "asyncio.Task py:class 1 library/asyncio-task.html#asyncio.Task -",
    ].join("\n");
    const docs = docsFromInventory(
      text,
      "https://docs.python.org/3/",
      ["asyncio", "gather"],
      3,
    );
    expect(docs[0]!.url).toBe(
      "https://docs.python.org/3/library/asyncio-task.html#asyncio.gather",
    );
    expect(docs[0]!.title).toBe("asyncio.gather");
  });

  test("curated docs entries match the query vocabulary", () => {
    const docs = docsFromCurated(
      [
        {
          title: "Validating References with Lifetimes",
          url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html",
        },
        {
          title: "Generic Data Types",
          url: "https://doc.rust-lang.org/book/ch10-01-syntax.html",
        },
      ],
      ["lifetimes"],
      2,
    );
    expect(docs.length).toBe(1);
    expect(docs[0]!.url).toContain("ch10-03-lifetime-syntax");
  });

  test("rss feeds turn company releases into doc candidates", () => {
    const xml = [
      "<rss><channel>",
      "<item><title><![CDATA[Introducing GPT-6]]></title><link>https://openai.com/index/introducing-gpt-6/</link></item>",
      "<item><title>GPT-5 is here</title><link>https://openai.com/index/introducing-gpt-5/</link></item>",
      "<item><title>Safety update</title><link>https://openai.com/index/safety/</link></item>",
      "</channel></rss>",
    ].join("");
    const hits = docsFromRss(xml, ["gpt-6"], 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.url).toBe("https://openai.com/index/introducing-gpt-6/");
    expect(hits[0]!.title).toBe("Introducing GPT-6");
  });

  test("the official ask falls back to the bare head when mined asks are thin", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (query) => {
      queries.push(query);
      if (!query.includes("site:")) {
        return [
          hit(
            "https://dailynews.example/a",
            "Harmonised standard update",
            "ai act",
          ),
          hit(
            "https://dailynews.example/b",
            "Harmonised standard review",
            "ai act",
          ),
        ];
      }
      if (query.includes("harmonised")) {
        return [
          hit(
            "https://digital-strategy.ec.europa.eu/x",
            "First harmonised standard",
            "ai act",
          ),
        ];
      }
      return [
        hit("https://digital-strategy.ec.europa.eu/a", "AI Act guidance", "ai"),
        hit("https://eur-lex.europa.eu/b", "AI Act regulation", "ai"),
        hit("https://ai-act-service-desk.ec.europa.eu/c", "AI Act FAQ", "ai"),
      ];
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "eu ai act harmonisation obligations 2026",
        { engines: [engNews] },
        { ...deps, suggest: null },
      ),
    );
    const urls = result.map((row) => row.url);
    expect(urls).toContain("https://eur-lex.europa.eu/b");
    expect(urls).toContain("https://ai-act-service-desk.ec.europa.eu/c");
    expect(queries.some((query) => query.startsWith("eu ai (site:"))).toBe(
      true,
    );
  });

  test("a thin first official ask retries with the runner-up term", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (query) => {
      queries.push(query);
      if (!query.includes("site:")) {
        return [
          hit(
            "https://dailynews.example/a",
            "Semicon India subsidy update",
            "subsidy scheme",
          ),
          hit(
            "https://dailynews.example/b",
            "Semicon India subsidy plans",
            "subsidy support",
          ),
        ];
      }
      return /\bsemicon\b/.test(query)
        ? [
            hit(
              "https://www.pmindia.gov.in/x",
              "PM inaugurates SEMICON India 2026",
              "",
            ),
          ]
        : [
            hit(
              "https://ec.europa.eu/ai-act",
              "AI Act obligations guidance",
              "obligations",
            ),
          ];
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews] },
        { ...deps, suggest: null },
      ),
    );
    expect(result.map((r) => r.url)).toContain("https://ec.europa.eu/ai-act");
    expect(queries.filter((query) => query.includes("site:")).length).toBe(3);
  });

  test("the official-source request carries the pool's official vocabulary", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (q) => {
      queries.push(q);
      return q.includes("site:")
        ? [
            hit(
              "https://www.pmindia.gov.in/x",
              "PM inaugurates SEMICON India 2026",
              "",
            ),
          ]
        : Array.from({ length: 12 }, (_, i) =>
            hit(
              `https://dailynews.example/semicon-${i}`,
              i < 2
                ? `Semicon India subsidy update ${i}`
                : `Semicon India 2026 update ${i}`,
              "subsidy scheme",
            ),
          );
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews] },
        deps,
      ),
    );
    const officialQuery = queries.find((q) => q.includes("site:"));
    expect(officialQuery).toBeDefined();
    expect(officialQuery!).toMatch(/\bsemicon\b/);
    // Only the top mined term rides along: the two-term form returns nothing
    // from Bing News (probed live), so "subsidy" must stay out.
    expect(officialQuery!).not.toMatch(/\bsubsidy\b/);
    expect(result.map((r) => r.url)).toContain("https://www.pmindia.gov.in/x");
    // The official hits are the curated, guarded search: they lead the news
    // bucket instead of trailing it, or the press list buries them.
    expect(result.slice(0, 3).map((r) => r.url)).toContain(
      "https://www.pmindia.gov.in/x",
    );
  });

  test("official hits lead even when other engines match the raw words", async () => {
    const engNews = fakeEngine("news", async (query) =>
      query.includes("site:")
        ? [
            hit(
              "https://www.pmindia.gov.in/x",
              "PM inaugurates SEMICON India 2026",
              "",
            ),
          ]
        : Array.from({ length: 6 }, (_, i) =>
            hit(
              `https://dailynews.example/semicon-${i}`,
              `Semicon India 2026 update ${i}`,
              "subsidy scheme",
            ),
          ),
    );
    const engBing = fakeEngine("bing", async () =>
      Array.from({ length: 4 }, (_, i) =>
        hit(
          `https://bing.example/${i}`,
          `India semiconductor subsidies 2026 ${i}`,
          "india semiconductor subsidies 2026",
        ),
      ),
    );
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews, engBing] },
        deps,
      ),
    );
    expect(result[0]!.url).toBe("https://www.pmindia.gov.in/x");
  });

  test("the dev-source ask runs even when the pool yields no vocabulary", async () => {
    const engMdn = fakeEngine("mdn", async () => [
      hit(
        "https://mdn.example/reconnect",
        "WebSocket reconnect notes",
        "websocket reconnect exponential backoff",
      ),
      hit(
        "https://mdn.example/backoff",
        "WebSocket backoff notes",
        "websocket reconnect exponential backoff",
      ),
    ]);
    const engGithub = fakeEngine("github", async (query) =>
      query.includes("websocket reconnect in:name")
        ? [
            hit(
              "https://github.com/joewalnes/reconnecting-websocket",
              "joewalnes/reconnecting-websocket",
              "reconnecting websocket exponential backoff javascript",
            ),
          ]
        : [],
    );
    const { fetcher } = stubFetcher({
      "https://mdn.example/reconnect":
        "websocket reconnect exponential backoff javascript",
      "https://mdn.example/backoff":
        "websocket reconnect exponential backoff javascript",
      "https://github.com/joewalnes/reconnecting-websocket":
        "reconnecting websocket exponential backoff javascript guide",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do i implement websocket reconnect with exponential backoff in javascript",
        { engines: [engMdn, engGithub], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(result[0]!.url).toBe(
      "https://github.com/joewalnes/reconnecting-websocket",
    );
  });

  test("the dev-source ask uses the topic phrase when the mined word is a verb", async () => {
    const engMdn = fakeEngine("mdn", async () => [
      hit(
        "https://mdn.example/reconnecting",
        "Reconnecting WebSocket",
        "websocket reconnect exponential backoff",
      ),
      hit(
        "https://mdn.example/reconnection",
        "WebSocket reconnection guide",
        "websocket reconnect exponential backoff",
      ),
    ]);
    const engGithub = fakeEngine("github", async (query) =>
      query.includes("websocket") && query.includes("in:name")
        ? [
            hit(
              "https://github.com/joewalnes/reconnecting-websocket",
              "joewalnes/reconnecting-websocket",
              "reconnecting websocket exponential backoff javascript",
            ),
          ]
        : [
            hit(
              "https://github.com/ned1313/Implementing-Terraform",
              "ned1313/Implementing-Terraform",
              "implementing terraform",
            ),
          ],
    );
    const { fetcher } = stubFetcher({
      "https://mdn.example/reconnecting":
        "implementing websocket reconnect implementing reconnecting",
      "https://mdn.example/reconnection":
        "implementing websocket reconnect implementing reconnection",
      "https://github.com/joewalnes/reconnecting-websocket":
        "reconnecting websocket exponential backoff javascript guide",
      "https://github.com/ned1313/Implementing-Terraform":
        "implementing terraform azure code examples",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do i implement websocket reconnect with exponential backoff in javascript",
        { engines: [engMdn, engGithub], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(result[0]!.url).toBe(
      "https://github.com/joewalnes/reconnecting-websocket",
    );
  });

  test("dev questions lift the named spec repo found by in:name", async () => {
    const engMdn = fakeEngine("mdn", async () => [
      hit(
        "https://developer.mozilla.org/async-iteration",
        "Async iteration and generators",
        "async iterators",
      ),
      hit(
        "https://developer.mozilla.org/asynciterator",
        "AsyncIterator - JavaScript",
        "async iterator protocol",
      ),
    ]);
    const engGithub = fakeEngine("github", async (query) =>
      query.includes("in:name")
        ? [
            hit(
              "https://github.com/tc39/proposal-async-iteration",
              "tc39/proposal-async-iteration",
              "Async iteration proposal",
            ),
          ]
        : [
            hit(
              "https://github.com/mushmomos/implementation",
              "mushmomos/implementation",
              "an implementation",
            ),
          ],
    );
    const { fetcher } = stubFetcher({
      "https://developer.mozilla.org/async-iteration":
        "async iterators iteration generators",
      "https://developer.mozilla.org/asynciterator": "async iterators protocol",
      "https://github.com/tc39/proposal-async-iteration":
        "async iterators iteration protocol spec",
      "https://github.com/mushmomos/implementation": "an implementation",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [engMdn, engGithub], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(result[0]!.url).toBe(
      "https://github.com/tc39/proposal-async-iteration",
    );
  });

  test("an official item already in the raw pool leads without a second search", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (query) => {
      queries.push(query);
      return [
        ...Array.from({ length: 6 }, (_, i) =>
          hit(
            `https://dailynews.example/semicon-${i}`,
            `Semicon India 2026 update ${i}`,
            "subsidy scheme",
          ),
        ),
        hit(
          "https://www.pmindia.gov.in/x",
          "PM inaugurates SEMICON India 2026",
          "",
        ),
      ];
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews] },
        deps,
      ),
    );
    expect(queries.some((query) => query.includes("site:"))).toBe(false);
    expect(result[0]!.url).toBe("https://www.pmindia.gov.in/x");
  });

  test("the official ask falls back to the RSS index when the news engine returns nothing", async () => {
    const engNews = fakeEngine("news", async (query) =>
      query.includes("site:")
        ? []
        : Array.from({ length: 6 }, (_, i) =>
            hit(
              `https://dailynews.example/semicon-${i}`,
              `Semicon India 2026 update ${i}`,
              "subsidy scheme",
            ),
          ),
    );
    const engBing = fakeEngine("bing", async (query) =>
      query.includes("site:")
        ? [
            hit(
              "https://www.pmindia.gov.in/x",
              "PM inaugurates SEMICON India 2026",
              "",
            ),
          ]
        : [],
    );
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews, engBing] },
        { ...deps, suggest: null },
      ),
    );
    expect(result[0]!.url).toBe("https://www.pmindia.gov.in/x");
  });

  test("a generic official page does not suppress the official-source request", async () => {
    const queries: string[] = [];
    const engNews = fakeEngine("news", async (q) => {
      queries.push(q);
      return q.includes("site:")
        ? [
            hit(
              "https://www.pib.gov.in/press/x",
              "Semicon 2.0 notified with semiconductor subsidies",
              "",
            ),
          ]
        : [
            hit(
              "https://www.india.gov.in/explore-india/facts-of-india",
              "Facts of India",
              "",
            ),
            hit(
              "https://dailynews.example/x",
              "India semiconductor subsidies 2026 update",
              "subsidies",
            ),
          ];
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "india semiconductor subsidies 2026",
        { engines: [engNews] },
        deps,
      ),
    );
    expect(queries.some((q) => q.includes("site:"))).toBe(true);
    expect(result.map((r) => r.url)).toContain(
      "https://www.pib.gov.in/press/x",
    );
  });

  test("the wave asks GitHub for repo names when a sibling term is mined", async () => {
    const queries: string[] = [];
    const engGithub = fakeEngine("github", async (query) => {
      queries.push(query);
      return query.includes("in:name")
        ? [
            hit(
              "https://github.com/tc39/proposal-async-iteration",
              "tc39/proposal-async-iteration",
              "async iteration proposal",
            ),
          ]
        : [
            hit(
              "https://github.com/lmammino/iteration-protocols-workshop",
              "lmammino/iteration-protocols-workshop",
              "async iterators workshop",
            ),
          ];
    });
    const engMdn = fakeEngine("mdn", async () => [
      hit("https://mdn.example/async-0", "async iterators guide", ""),
      hit("https://mdn.example/async-1", "async iterators guide two", ""),
    ]);
    const { fetcher } = stubFetcher({
      "https://github.com/lmammino/iteration-protocols-workshop":
        "async iterators notes",
      "https://mdn.example/async-0": "async iterators iteration notes",
      "https://mdn.example/async-1": "async iterators iteration notes",
      "https://github.com/tc39/proposal-async-iteration":
        "async iterators iteration protocol",
    });
    const { deps } = freshDeps();
    const { result } = await captureStderr(() =>
      search(
        "how do async iterators work in javascript",
        { engines: [engMdn, engGithub], rerank: true, pageFetcher: fetcher },
        { ...deps, suggest: null },
      ),
    );
    expect(queries.some((q) => q.includes("in:name"))).toBe(true);
    expect(result.map((r) => r.url)).toContain(
      "https://github.com/tc39/proposal-async-iteration",
    );
  });
});

describe("token rarity weighting", () => {
  test("rare query tokens outweigh generic ones in the relevance ranking", () => {
    const generic1 = hit(
      "https://so.example/q1",
      "How to handle nested objects in Laravel",
      "nested objects",
    );
    const generic2 = hit(
      "https://so.example/q2",
      "Why does automapper not handle nested objects",
      "nested objects",
    );
    const specific = hit(
      "https://mdn.example/structuredClone",
      "Window: structuredClone() method",
      "structuredClone deep clones nested objects",
    );
    const fused = fuseResults(
      "how does structuredclone handle nested objects",
      [[generic1, generic2], [specific]],
    );
    expect(fused[0]!.url).toBe(specific.url);
  });

  test("a page missing the rarest query token ranks below one that has it", () => {
    const generic = hit(
      "https://so.example/q1",
      "How to handle nested objects",
      "nested objects",
    );
    const specific = hit(
      "https://mdn.example/structuredClone",
      "Window: structuredClone() method",
      "structuredClone",
    );
    const fused = fuseResults(
      "how does structuredclone handle nested objects",
      [[generic], [specific]],
    );
    expect(fused[0]!.url).toBe(specific.url);
  });
});

describe("domain trust", () => {
  test("trust breaks exact fusion ties toward verified domains", () => {
    const a = hit("https://a.example/x", "Async iterator guide", "one");
    const b = hit("https://b.example/y", "Async iterator guide", "two");
    const untrusted = fuseResults("async iterator", [
      [a, b],
      [a, b],
    ]);
    expect(untrusted.map((r) => r.url)).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
    const trusted = fuseResults(
      "async iterator",
      [
        [a, b],
        [a, b],
      ],
      new Map([
        ["a.example", 0.5],
        ["b.example", 1],
      ]),
    );
    expect(trusted.map((r) => r.url)).toEqual([
      "https://b.example/y",
      "https://a.example/x",
    ]);
  });

  test("rerank verdicts land in the trust file with the right polarity", async () => {
    const dense =
      "Async iterators drain promise queues; the iterator protocol awaits each result as the queue gives it up.";
    const eng = fakeEngine("default", async () => [
      hit(
        "https://good.example/async",
        "Async iterator deep guide",
        "engine snippet",
      ),
      hit(
        "https://bad.example/noise",
        "Generic programming notes",
        "nothing here",
      ),
    ]);
    const { fetcher } = stubFetcher({
      "https://good.example/async": dense,
      "https://bad.example/noise":
        "Completely unrelated content about gardening.",
    });
    const { deps } = freshDeps();
    await captureStderr(() =>
      search(
        "async iterator protocol",
        { engines: [eng], rerank: true, pageFetcher: fetcher },
        deps,
      ),
    );
    const raw = readFileSync(join(deps.dir!, "trust.jsonl"), "utf8");
    expect(raw).toContain('"d":"good.example","p":1');
    expect(raw).toContain('"d":"bad.example","p":0');
  });
});

describe("engine cooldowns", () => {
  test("benches an engine that times out twice, then skips it next run", async () => {
    const { deps } = freshDeps();
    // The web engines get asked twice for keyword queries (the original plus
    // the alias pair), so two timeouts land inside one run.
    const dead = fakeEngine("duckduckgo", async () => {
      throw new Error("engine duckduckgo timed out after 2000ms");
    });
    const live = fakeEngine("solo", async () => [
      hit("https://good.example/1", "API throttling rate limiting"),
    ]);
    const first = await captureStderr(() =>
      search("api throttling", { engines: [dead, live] }, deps),
    );
    expect(dead.calls).toBe(2);
    expect(
      first.logs.some((line) =>
        line.includes("engine duckduckgo benched for 10m (2 timeouts)"),
      ),
    ).toBe(true);

    const revived = fakeEngine("duckduckgo", async () => [
      hit("https://loved.example/2", "Revived engine"),
    ]);
    const second = await captureStderr(() =>
      search(
        "api throttling",
        { engines: [revived, live], noCache: true },
        deps,
      ),
    );
    // The persistent cooldown skips the engine entirely; only the live one runs.
    expect(revived.calls).toBe(0);
    expect(
      second.logs.some((line) =>
        line.includes("engine duckduckgo benched (cooling down)"),
      ),
    ).toBe(true);
    expect(second.result.map((row) => row.url)).toEqual([
      "https://good.example/1",
    ]);
  });

  test("a single timeout per run does not bench the engine", async () => {
    const { deps } = freshDeps();
    let attempts = 0;
    const flaky = fakeEngine("duckduckgo", async () => {
      attempts += 1;
      if (attempts === 1)
        throw new Error("engine duckduckgo timed out after 2000ms");
      return [hit("https://good.example/1", "API throttling rate limiting")];
    });
    const first = await captureStderr(() =>
      search(
        "api throttling",
        { engines: [flaky] },
        { ...deps, suggest: null },
      ),
    );
    expect(first.result.length).toBeGreaterThan(0);
    for (const line of first.logs)
      expect(line).not.toContain("benched for 10m");
  });
});

describe("blackout retry", () => {
  test("re-asks the engines once when every call times out", async () => {
    const { deps } = freshDeps();
    let betaTries = 0;
    const alpha = fakeEngine("alpha", async () => {
      throw new Error("engine alpha timed out after 2000ms");
    });
    const beta = fakeEngine("beta", async () => {
      betaTries += 1;
      if (betaTries === 1)
        throw new Error("engine beta timed out after 2000ms");
      return [hit("https://good.example/1", "Bun runtime release")];
    });
    const { result, logs } = await captureStderr(() =>
      search(
        "bun runtime release",
        { engines: [alpha, beta] },
        { ...deps, suggest: null },
      ),
    );
    expect(
      logs.some((line) =>
        line.includes("every engine timed out; retrying once"),
      ),
    ).toBe(true);
    expect(alpha.calls).toBe(2);
    expect(beta.calls).toBe(2);
    expect(result.map((row) => row.url)).toEqual(["https://good.example/1"]);
  });

  test("a slow engine that answers on the retry is kept and not benched", async () => {
    const { deps } = freshDeps();
    let tries = 0;
    const slow = fakeEngine("alpha", async () => {
      tries += 1;
      if (tries === 1) throw new Error("engine alpha timed out after 2000ms");
      return [hit("https://good.example/1", "Bun runtime release")];
    });
    const { result, logs } = await captureStderr(() =>
      search(
        "bun runtime release",
        { engines: [slow] },
        { ...deps, suggest: null },
      ),
    );
    expect(tries).toBe(2);
    expect(result.map((row) => row.url)).toEqual(["https://good.example/1"]);
    for (const line of logs) expect(line).not.toContain("benched for 10m");
  });

  test("an engine that stays silent through the retry is benched", async () => {
    const { deps } = freshDeps();
    const dead = fakeEngine("alpha", async () => {
      throw new Error("engine alpha timed out after 2000ms");
    });
    const attempt = captureStderr(() =>
      search(
        "bun runtime release",
        { engines: [dead] },
        { ...deps, suggest: null },
      ),
    );
    await expect(attempt).rejects.toThrow("all engines failed");
    expect(dead.calls).toBe(2);
  });

  test("an unrelated suggestion never replaces a full-blackout query", async () => {
    const { deps } = freshDeps();
    const alpha = fakeEngine("alpha", async () => {
      throw new Error("engine alpha timed out after 2000ms");
    });
    const attempt = captureStderr(() =>
      search(
        "latest stable bun release october 2026",
        { engines: [alpha] },
        { ...deps, suggest: async () => "fastelavn bun run 2026" },
      ),
    );
    await expect(attempt).rejects.toThrow("all engines failed");
  });
});
