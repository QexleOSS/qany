import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDdgHref,
  isBraveChallenge,
  isDdgChallenge,
  makeArxivEngine,
  makeBingEngine,
  makeBraveEngine,
  makeDdgEngine,
  makeGithubEngine,
  makeHnEngine,
  makeMdnEngine,
  makeMwmblEngine,
  makeNewsEngine,
  makeNpmEngine,
  makeOpenAlexEngine,
  makeRightDaoEngine,
  makeStackoverflowEngine,
  makeWikiEngine,
  parseArxivXml,
  parseBingNewsRss,
  parseBingRss,
  parseBraveHtml,
  parseDdgHtml,
  parseGithubJson,
  parseHnJson,
  parseMdnJson,
  parseNpmJson,
  parseOpenAlexJson,
  parseRightDaoHtml,
  parseStackExchangeJson,
  parseWikiJson,
  suggestQuery,
} from "../src/engines";
import { createHttpState, type HttpDeps } from "../src/http";

const fixture = (name: string) => readFileSync(`test/fixtures/${name}`, "utf8");

class FakeClock {
  t = 0;
  sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

function fakeDeps(
  body: string,
  status = 200,
): { deps: HttpDeps; calls: () => number } {
  let calls = 0;
  const deps: HttpDeps = {
    state: createHttpState(),
    // Temp cooldown dir: tests must not read or write the real cache state.
    dir: mkdtempSync(join(tmpdir(), "qany-engine-")),
    fetch: async () => {
      calls += 1;
      return new Response(body, { status });
    },
  };
  return { deps, calls: () => calls };
}

describe("parseDdgHtml", () => {
  test("parses a real DDG results page", async () => {
    const results = await parseDdgHtml(fixture("ddg-html.html"));
    expect(results.length).toBe(10);
    expect(results[0]!.url).toBe("https://bun.com/docs/runtime");
    for (const r of results) {
      expect(r.engine).toBe("duckduckgo");
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.snippet.length).toBeGreaterThan(0);
      expect(r.url.startsWith("https://")).toBe(true);
      expect(r.url.includes("duckduckgo.com/l/")).toBe(false);
    }
  });

  test("returns [] for the anomaly page", async () => {
    const anomaly = fixture("ddg-post.html");
    expect(isDdgChallenge(anomaly)).toBe(true);
    expect(await parseDdgHtml(anomaly)).toEqual([]);
  });

  test("returns [] for empty input", async () => {
    expect(await parseDdgHtml("")).toEqual([]);
  });

  test("decodes entities in titles and snippets", async () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Egypt&#x27;s &amp; Co &#x2F; tax</a><a class="result__snippet">laws &lt;b&gt; of 2025</a>`;
    const results = await parseDdgHtml(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Egypt's & Co / tax");
    expect(results[0]!.snippet).toBe("laws <b> of 2025");
  });
});

describe("decodeDdgHref", () => {
  test("decodes the redirect wrapper", () => {
    expect(
      decodeDdgHref(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.com%2Fdocs&rut=abc123",
      ),
    ).toBe("https://bun.com/docs");
  });

  test("passes absolute and protocol-relative urls through", () => {
    expect(decodeDdgHref("https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(decodeDdgHref("//example.com/y")).toBe("https://example.com/y");
  });
});

describe("parseBingRss", () => {
  test("parses the real feed and skips bing.com self-links", () => {
    const results = parseBingRss(fixture("bing-rss.xml"));
    expect(results.length).toBeGreaterThanOrEqual(8);
    expect(results.some((r) => r.url === "https://bun.com/")).toBe(true);
    for (const r of results) {
      expect(r.engine).toBe("bing");
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.url.includes("bing.com")).toBe(false);
    }
  });

  test("decodes entities and CDATA", () => {
    const xml =
      "<rss><channel>" +
      "<item><title>Rust &amp; Cargo</title><link>https://doc.rust-lang.org/</link>" +
      "<description><![CDATA[The <b>Rust</b> book]]></description></item>" +
      "<item><title>No link</title><description>skip me</description></item>" +
      "</channel></rss>";
    const results = parseBingRss(xml);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Rust & Cargo");
    expect(results[0]!.snippet).toBe("The Rust book");
  });

  test("returns [] for empty input", () => {
    expect(parseBingRss("")).toEqual([]);
  });
});

describe("parseBingNewsRss", () => {
  test("parses the real feed and unwraps apiclick links", () => {
    const results = parseBingNewsRss(fixture("bing-news.xml"));
    expect(results.length).toBe(4);
    expect(results[0]!.title).toBe(
      "Final deadline to benefit from Egypt\u2019s 2025 tax relief is 12 August: ETA chief",
    );
    expect(results[0]!.url).toBe(
      "https://www.dailynewsegypt.com/2025/06/02/final-deadline-to-benefit-from-egypts-2025-tax-relief-is-12-august-eta-chief/",
    );
    expect(results[0]!.snippet).toContain("Rasha Abdel Aal");
    for (const r of results) {
      expect(r.engine).toBe("news");
      expect(r.url.includes("bing.com")).toBe(false);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  test("keeps direct links, unwraps wrapped ones, skips broken ones", () => {
    const xml =
      "<rss><channel>" +
      "<item><title>Direct link</title><link>https://example.com/news</link>" +
      "<description>Hello</description></item>" +
      "<item><title>Wrapped</title>" +
      "<link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1</link>" +
      "<description></description><News:Source>Example News</News:Source></item>" +
      "<item><title>Broken wrapper</title>" +
      "<link>http://www.bing.com/news/apiclick.aspx?ref=x</link>" +
      "<description>skip me</description></item>" +
      "</channel></rss>";
    const results = parseBingNewsRss(xml);
    expect(results.length).toBe(2);
    expect(results[0]!.url).toBe("https://example.com/news");
    expect(results[1]!.url).toBe("https://example.org/a?b=1");
    expect(results[1]!.snippet).toBe("Example News");
  });

  test("returns [] for empty input", () => {
    expect(parseBingNewsRss("")).toEqual([]);
  });
});

describe("parseHnJson", () => {
  test("parses the real Algolia response", () => {
    const results = parseHnJson(JSON.parse(fixture("hn.json")));
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.engine).toBe("hn");
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.snippet).toMatch(/^HN · \d+ points$/);
    }
  });

  test("falls back to the HN item page for comment hits", () => {
    const results = parseHnJson({
      hits: [
        {
          title: null,
          story_title: "Ask HN: something",
          url: null,
          objectID: "123",
          points: 42,
        },
      ],
    });
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe("https://news.ycombinator.com/item?id=123");
    expect(results[0]!.title).toBe("Ask HN: something");
    expect(results[0]!.snippet).toBe("HN · 42 points");
  });

  test("returns [] for garbage input", () => {
    expect(parseHnJson({})).toEqual([]);
    expect(parseHnJson(null)).toEqual([]);
  });
});

describe("parseWikiJson", () => {
  test("parses the real search response and strips html from snippets", () => {
    const results = parseWikiJson(JSON.parse(fixture("wiki.json")));
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results[0]!.url).toContain("Bun_(software)");
    for (const r of results) {
      expect(r.engine).toBe("wiki");
      expect(r.url.startsWith("https://en.wikipedia.org/wiki/")).toBe(true);
      expect(r.snippet.includes("<")).toBe(false);
      expect(r.snippet.length).toBeGreaterThan(0);
    }
  });

  test("encodes question marks in page titles", () => {
    const results = parseWikiJson({ query: { search: [{ title: "Who?" }] } });
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe("https://en.wikipedia.org/wiki/Who%3F");
  });

  test("returns [] for garbage input", () => {
    expect(parseWikiJson({})).toEqual([]);
  });
});

describe("parseMdnJson", () => {
  test("parses the real MDN search response", () => {
    const results = parseMdnJson(JSON.parse(fixture("mdn.json")));
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.title).toBe("Iterators and generators");
    expect(results[0]!.url).toBe(
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Iterators_and_generators",
    );
    expect(results[0]!.snippet).toContain("core language");
    for (const r of results) {
      expect(r.engine).toBe("mdn");
      expect(r.url.startsWith("https://developer.mozilla.org/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  test("skips entries without a path or title", () => {
    const results = parseMdnJson({
      documents: [{ title: "No path" }, { mdn_url: "/en-US/docs/x" }, null],
    });
    expect(results).toEqual([]);
  });

  test("returns [] for garbage input", () => {
    expect(parseMdnJson(null)).toEqual([]);
    expect(parseMdnJson({})).toEqual([]);
  });
});

describe("parseStackExchangeJson", () => {
  test("parses the real Stack Exchange search response", () => {
    const results = parseStackExchangeJson(
      JSON.parse(fixture("stackexchange.json")),
    );
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results[0]!.title).toBe(
      "Events vs Streams vs Observables vs Async Iterators",
    );
    expect(results[0]!.url).toBe(
      "https://stackoverflow.com/questions/39439653/events-vs-streams-vs-observables-vs-async-iterators",
    );
    expect(results[0]!.snippet).toBe("SO · score 66 · 2 answers");
    for (const r of results) {
      expect(r.engine).toBe("stackoverflow");
      expect(r.url.startsWith("https://stackoverflow.com/")).toBe(true);
      expect(r.snippet).toMatch(/^SO · score -?\d+ · \d+ answers?$/);
    }
  });

  test("skips items without an http link or title", () => {
    const results = parseStackExchangeJson({
      items: [
        { title: "No link" },
        { link: "https://stackoverflow.com/q/1" },
        { title: "ftp", link: "ftp://example.com/x" },
      ],
    });
    expect(results).toEqual([]);
  });

  test("returns [] for garbage input", () => {
    expect(parseStackExchangeJson(null)).toEqual([]);
  });
});

describe("parseBraveHtml", () => {
  test("parses the real Brave results page", async () => {
    const results = await parseBraveHtml(fixture("brave.html"));
    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results.every((r) => r.title.length > 0)).toBe(true);
    expect(results.every((r) => /^https?:\/\//.test(r.url))).toBe(true);
    expect(
      results.every((r) => !/(^|\.)brave\.com$/.test(new URL(r.url).hostname)),
    ).toBe(true);
    expect(new Set(results.map((r) => r.url)).size).toBe(results.length);
    expect(results.every((r) => r.engine === "brave")).toBe(true);
    const mdn = results.find(
      (r) =>
        r.url ===
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator",
    );
    expect(mdn).toBeDefined();
    expect(mdn!.title).toBe("AsyncIterator - JavaScript - MDN Web Docs");
    expect(mdn!.snippet).toContain("async iterator protocol");
    expect(mdn!.snippet.startsWith("October")).toBe(false);
  });

  test("skips untitled anchors, relative and brave hosts, and dedupes urls", async () => {
    const html =
      '<a href="https://example.com/a"><div class="search-snippet-title">Alpha</div></a>' +
      '<div class="generic-snippet"><div class="content">fiber</div></div>' +
      '<a href="https://example.com/a"><div class="search-snippet-title">Alpha again</div></a>' +
      '<a href="/relative/path"><div class="search-snippet-title">Rel</div></a>' +
      '<a href="https://about.brave.com/privacy"><div class="search-snippet-title">Brave</div></a>' +
      '<a href="https://example.com/b"><p>just noise</p></a>' +
      '<div class="generic-snippet"><div class="content">orphan snippet</div></div>';
    const results = await parseBraveHtml(html);
    expect(results).toEqual([
      {
        title: "Alpha",
        url: "https://example.com/a",
        snippet: "fiber",
        engine: "brave",
      },
    ]);
  });

  test("strips a leading date from snippets", async () => {
    const html =
      '<a href="https://example.com/x"><div class="search-snippet-title">X</div></a>' +
      '<div class="generic-snippet"><div class="content"><span class="t-secondary">March 3, 2026 -</span> fact</div></div>';
    const results = await parseBraveHtml(html);
    expect(results[0]!.snippet).toBe("fact");
  });

  test("decodes entities in titles and snippets", async () => {
    const html =
      '<a href="https://example.com/y"><div class="search-snippet-title">Node&amp;Co</div></a>' +
      '<div class="generic-snippet"><div class="content">don&#39;t panic</div></div>';
    const results = await parseBraveHtml(html);
    expect(results[0]!.title).toBe("Node&Co");
    expect(results[0]!.snippet).toBe("don't panic");
  });

  test("detects challenge pages", () => {
    expect(isBraveChallenge("<html><title>Access Denied</title></html>")).toBe(
      true,
    );
    expect(
      isBraveChallenge("<html><body>cf-chl token submitted</body></html>"),
    ).toBe(true);
    expect(
      isBraveChallenge("<html><body>captcha-required=1</body></html>"),
    ).toBe(true);
    expect(isBraveChallenge("<html><body>ordinary results</body></html>")).toBe(
      false,
    );
    expect(isBraveChallenge(fixture("brave.html"))).toBe(false);
  });
});

describe("parseGithubJson", () => {
  test("parses the real GitHub repository search response", () => {
    const results = parseGithubJson(JSON.parse(fixture("github.json")));
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results[0]!.title).toBe("tc39/proposal-async-iteration");
    expect(results[0]!.url).toBe(
      "https://github.com/tc39/proposal-async-iteration",
    );
    expect(results[0]!.snippet).toContain(
      "Asynchronous iteration for JavaScript",
    );
    for (const r of results) {
      expect(r.engine).toBe("github");
      expect(r.url.startsWith("https://github.com/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.snippet.length).toBeGreaterThan(0);
    }
  });

  test("falls back to stars for missing descriptions and skips bad items", () => {
    const results = parseGithubJson({
      items: [
        {
          full_name: "a/b",
          html_url: "https://github.com/a/b",
          description: null,
          stargazers_count: 12,
        },
        {
          full_name: "c/d",
          html_url: "https://gitlab.com/c/d",
          description: "outside",
        },
        { html_url: "https://github.com/e/f", description: "no name" },
        {
          full_name: "g/h",
          html_url: "https://github.com/g/h",
          description: "stary",
        },
      ],
    });
    expect(results).toEqual([
      {
        title: "a/b",
        url: "https://github.com/a/b",
        snippet: "GH · 12 stars",
        engine: "github",
      },
      {
        title: "g/h",
        url: "https://github.com/g/h",
        snippet: "stary",
        engine: "github",
      },
    ]);
  });

  test("returns [] for garbage input", () => {
    expect(parseGithubJson(null)).toEqual([]);
    expect(parseGithubJson({})).toEqual([]);
  });
});

describe("parseNpmJson", () => {
  test("parses the real npm registry search response", () => {
    const results = parseNpmJson(JSON.parse(fixture("npm.json")));
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results[0]!.title).toBe("fast-readable-async-iterator");
    expect(results[0]!.url).toBe(
      "https://www.npmjs.com/package/fast-readable-async-iterator",
    );
    expect(results[0]!.snippet).toBe(
      "Fast Async Iterator for browser Readable Streams.",
    );
    for (const r of results) {
      expect(r.engine).toBe("npm");
      expect(r.url.startsWith("https://www.npmjs.com/package/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  test("constructs urls when links are missing and skips bad items", () => {
    const results = parseNpmJson({
      objects: [
        { package: { name: "@scope/pkg", description: "scoped helper" } },
        { package: { description: "no name" } },
        { other: "not a package" },
      ],
    });
    expect(results).toEqual([
      {
        title: "@scope/pkg",
        url: "https://www.npmjs.com/package/@scope/pkg",
        snippet: "scoped helper",
        engine: "npm",
      },
    ]);
  });

  test("returns [] for garbage input", () => {
    expect(parseNpmJson(null)).toEqual([]);
    expect(parseNpmJson({})).toEqual([]);
  });
});

describe("parseArxivXml", () => {
  test("parses the real arXiv Atom feed", () => {
    const results = parseArxivXml(fixture("arxiv.xml"));
    expect(results.length).toBe(3);
    expect(results[0]!.title).toBe(
      "Multi-Objective Adaptive Rate Limiting in Microservices Using Deep Reinforcement Learning",
    );
    expect(results[0]!.url).toBe("https://arxiv.org/abs/2511.03279");
    expect(results[0]!.snippet).toContain("critical mechanism");
    expect(results[0]!.snippet.length).toBeLessThanOrEqual(240);
    for (const r of results) {
      expect(r.engine).toBe("arxiv");
      expect(r.url.startsWith("https://arxiv.org/abs/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  test("skips entries without a title or id and handles garbage", () => {
    const xml = [
      "<feed>",
      "<entry><title>Only a title</title></entry>",
      "<entry><id>http://arxiv.org/abs/2401.00001v2</id></entry>",
      "<entry><id>http://arxiv.org/abs/2401.00002v1</id><title>Real one</title><summary>Abstract here.</summary></entry>",
      "</feed>",
    ].join("");
    const results = parseArxivXml(xml);
    expect(results).toEqual([
      {
        title: "Real one",
        url: "https://arxiv.org/abs/2401.00002",
        snippet: "Abstract here.",
        engine: "arxiv",
      },
    ]);
    expect(parseArxivXml("not xml at all")).toEqual([]);
  });
});

describe("parseOpenAlexJson", () => {
  test("parses the real OpenAlex response", () => {
    const results = parseOpenAlexJson(JSON.parse(fixture("openalex.json")));
    expect(results.length).toBe(3);
    expect(results[0]!.title).toBe(
      "On Computing Throttling Rate Limits in Web APIs through Statistical Inference",
    );
    expect(results[0]!.url).toBe("https://doi.org/10.1109/icws.2019.00075");
    expect(results[0]!.snippet).toContain("2019");
    expect(results[0]!.snippet).toContain("9 citations");
    for (const r of results) {
      expect(r.engine).toBe("openalex");
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  test("falls back to the doi or the openalex id for the url", () => {
    const results = parseOpenAlexJson({
      results: [
        {
          display_name: "Doi paper",
          doi: "https://doi.org/10.1/x",
          publication_year: 2020,
          cited_by_count: 5,
        },
        { display_name: "Id paper", id: "https://openalex.org/W9" },
        { cited_by_count: 3 },
      ],
    });
    expect(results).toEqual([
      {
        title: "Doi paper",
        url: "https://doi.org/10.1/x",
        snippet: "2020 · 5 citations",
        engine: "openalex",
      },
      {
        title: "Id paper",
        url: "https://openalex.org/W9",
        snippet: "",
        engine: "openalex",
      },
    ]);
  });

  test("returns [] for garbage input", () => {
    expect(parseOpenAlexJson(null)).toEqual([]);
    expect(parseOpenAlexJson({})).toEqual([]);
  });
});

describe("parseRightDaoHtml", () => {
  test("reads the title, url and snippet of every item block", () => {
    const results = parseRightDaoHtml(fixture("rightdao.html"));
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe(
      "Technical SEO Audit: A 10-Step Technical Audit Checklist",
    );
    expect(results[0]!.url).toBe(
      "https://www.semrush.com/blog/technical-seo-audit/",
    );
    expect(results[0]!.engine).toBe("rightdao");
    expect(results[0]!.snippet).toBe(
      "How to Perform a Technical SEO Audit in 10 Steps",
    );
    expect(results[0]!.snippet).not.toContain("2021");
  });

  test("ignores blocks without a title anchor", () => {
    const results = parseRightDaoHtml(
      '<div class="item"><div class="title">no anchor</div></div>',
    );
    expect(results.length).toBe(0);
  });
});

describe("engines", () => {
  test("rightdao engine parses the result list", async () => {
    const { deps } = fakeDeps(fixture("rightdao.html"));
    const results = await makeRightDaoEngine(deps).search(
      "technical seo audit",
      2,
    );
    expect(results.length).toBe(2);
    expect(results[0]!.url).toBe(
      "https://www.semrush.com/blog/technical-seo-audit/",
    );
  });

  test("ddg engine returns parsed results capped at num", async () => {
    const { deps } = fakeDeps(fixture("ddg-html.html"));
    const engine = makeDdgEngine(deps);
    const results = await engine.search("bun typescript runtime", 3);
    expect(results.length).toBe(3);
    expect(results[0]!.url).toBe("https://bun.com/docs/runtime");
  });

  test("ddg engine cools down for 10 minutes after a challenge", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps: HttpDeps = {
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      dir: mkdtempSync(join(tmpdir(), "qany-engine-")),
      fetch: async () => {
        calls += 1;
        return new Response(fixture("ddg-post.html"), { status: 200 });
      },
    };
    const engine = makeDdgEngine(deps);
    expect(await engine.search("bun", 5)).toEqual([]);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await engine.search("bun", 5)).toEqual([]);
    expect(calls).toBe(afterFirst);
    clock.t += 10 * 60_000 + 1;
    await engine.search("bun", 5);
    expect(calls).toBeGreaterThan(afterFirst);
  });

  test("bing engine parses the RSS feed", async () => {
    const { deps } = fakeDeps(fixture("bing-rss.xml"));
    const results = await makeBingEngine(deps).search("bun runtime", 5);
    expect(results.length).toBe(5);
    expect(results.some((r) => r.url === "https://bun.com/")).toBe(true);
  });

  test("news engine parses the Bing News RSS feed", async () => {
    const { deps } = fakeDeps(fixture("bing-news.xml"));
    const results = await makeNewsEngine(deps).search("egypt tax laws 2025", 2);
    expect(results.length).toBe(2);
    expect(results[0]!.url).toBe(
      "https://www.dailynewsegypt.com/2025/06/02/final-deadline-to-benefit-from-egypts-2025-tax-relief-is-12-august-eta-chief/",
    );
    expect(results[0]!.engine).toBe("news");
  });

  test("hn engine parses the Algolia JSON", async () => {
    const { deps } = fakeDeps(fixture("hn.json"));
    const results = await makeHnEngine(deps).search("bun runtime", 6);
    expect(results.length).toBe(6);
    expect(results[0]!.snippet).toMatch(/^HN · /);
  });

  test("wiki engine parses the MediaWiki JSON", async () => {
    const { deps } = fakeDeps(fixture("wiki.json"));
    const results = await makeWikiEngine(deps).search("bun runtime", 4);
    expect(results.length).toBe(4);
    expect(results[0]!.url).toContain("Bun_(software)");
  });

  test("mdn engine parses the search API JSON", async () => {
    const { deps } = fakeDeps(fixture("mdn.json"));
    const results = await makeMdnEngine(deps).search(
      "async iterators javascript",
      2,
    );
    expect(results.length).toBe(2);
    expect(results[0]!.engine).toBe("mdn");
    expect(results[0]!.url).toContain("developer.mozilla.org");
  });

  test("stackoverflow engine parses the search API JSON", async () => {
    const { deps } = fakeDeps(fixture("stackexchange.json"));
    const results = await makeStackoverflowEngine(deps).search(
      "async iterators javascript",
      1,
    );
    expect(results.length).toBe(1);
    expect(results[0]!.engine).toBe("stackoverflow");
    expect(results[0]!.url).toContain("stackoverflow.com");
  });

  test("brave engine parses results html capped at num", async () => {
    const { deps } = fakeDeps(fixture("brave.html"));
    const results = await makeBraveEngine(deps).search(
      "how do async iterators work",
      3,
    );
    expect(results.length).toBe(3);
    expect(results[0]!.engine).toBe("brave");
    expect(results.some((r) => r.url.includes("developer.mozilla.org"))).toBe(
      true,
    );
  });

  test("brave engine cools down for 10 minutes after a challenge", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps: HttpDeps = {
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      dir: mkdtempSync(join(tmpdir(), "qany-engine-")),
      fetch: async () => {
        calls += 1;
        return new Response("<html><title>Access Denied</title></html>", {
          status: 200,
        });
      },
    };
    const engine = makeBraveEngine(deps);
    expect(await engine.search("bun", 5)).toEqual([]);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await engine.search("bun", 5)).toEqual([]);
    expect(calls).toBe(afterFirst);
    clock.t += 10 * 60_000 + 1;
    await engine.search("bun", 5);
    expect(calls).toBeGreaterThan(afterFirst);
  });

  test("ddg cooldown persists across engine instances", async () => {
    const clock = new FakeClock();
    const dir = mkdtempSync(join(tmpdir(), "qany-engine-"));
    let calls = 0;
    const fetchStub = async () => {
      calls += 1;
      return new Response(fixture("ddg-post.html"), { status: 200 });
    };
    await makeDdgEngine({
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      fetch: fetchStub,
      dir,
    }).search("bun", 5);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    // A fresh instance stands in for the next CLI run (new process, same dir).
    await makeDdgEngine({
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      fetch: fetchStub,
      dir,
    }).search("bun", 5);
    expect(calls).toBe(afterFirst);
  });

  test("ddg treats fetch failures as a cooldown", async () => {
    const clock = new FakeClock();
    const dir = mkdtempSync(join(tmpdir(), "qany-engine-"));
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network down");
    };
    await makeDdgEngine({
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      fetch: failing,
      dir,
    }).search("bun", 5);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    await makeDdgEngine({
      state: createHttpState(),
      now: clock.now,
      sleep: clock.sleep,
      fetch: failing,
      dir,
    }).search("bun", 5);
    expect(calls).toBe(afterFirst);
  });

  test("mwmbl engine parses the search page", async () => {
    const { deps } = fakeDeps(fixture("mwmbl.html"));
    const results = await makeMwmblEngine(deps).search("bun runtime", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.url).toBe("https://bun.sh/docs/runtime");
    expect(results[0]!.title).toContain("Bun");
    expect(results[0]!.snippet).toContain("JavaScriptCore");
    expect(results[0]!.engine).toBe("mwmbl");
  });

  test("github engine parses the repository JSON", async () => {
    const { deps } = fakeDeps(fixture("github.json"));
    const results = await makeGithubEngine(deps).search(
      "async iterators javascript",
      2,
    );
    expect(results.length).toBe(2);
    expect(results[0]!.engine).toBe("github");
    expect(results[0]!.url).toContain("tc39");
  });

  test("npm engine parses the registry JSON", async () => {
    const { deps } = fakeDeps(fixture("npm.json"));
    const results = await makeNpmEngine(deps).search("async iterator", 1);
    expect(results.length).toBe(1);
    expect(results[0]!.engine).toBe("npm");
    expect(results[0]!.url).toContain("npmjs.com");
  });

  test("suggestQuery parses ddg autocomplete and skips the input itself", async () => {
    const { deps } = fakeDeps(fixture("ddg-ac.json"));
    expect(await suggestQuery("throtling api", deps)).toBe("throttling api");
    const selfOnly = fakeDeps('["aa",["aa","aa"]]', 200).deps;
    expect(await suggestQuery("aa", selfOnly)).toBe(null);
  });

  test("suggestQuery returns null on garbage or non-200", async () => {
    const { deps } = fakeDeps("not json", 200);
    expect(await suggestQuery("x y", deps)).toBe(null);
    const { deps: bad } = fakeDeps("[]", 500);
    expect(await suggestQuery("x y", bad)).toBe(null);
  });

  test("arxiv engine parses the Atom feed", async () => {
    const { deps } = fakeDeps(fixture("arxiv.xml"));
    const results = await makeArxivEngine(deps).search("rate limiting", 2);
    expect(results.length).toBe(2);
    expect(results[0]!.engine).toBe("arxiv");
    expect(results[0]!.url).toContain("arxiv.org/abs/");
  });

  test("openalex engine parses the works JSON", async () => {
    const { deps } = fakeDeps(fixture("openalex.json"));
    const results = await makeOpenAlexEngine(deps).search(
      "rate limiting apis",
      1,
    );
    expect(results.length).toBe(1);
    expect(results[0]!.engine).toBe("openalex");
    expect(results[0]!.title).toContain("Throttling Rate Limits");
  });
});
