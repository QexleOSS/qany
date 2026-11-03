import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheSet } from "../src/cache";
import { extractReadable, fetchPage } from "../src/fetch";
import { createHttpState, type FetchLike } from "../src/http";

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <title>Fixture &amp; Page</title>
  <style>body { color: red; }</style>
  <script>console.log("noise")</script>
</head>
<body>
  <nav>Home | About</nav>
  <main>
    <h1>Hello   World</h1>
    <p>First paragraph with <b>bold</b> text.</p>
    <aside>Related links</aside>
    <form><button>Submit form noise</button></form>
  </main>
  <footer>Copyright noise</footer>
</body>
</html>`;

const PAGE_URL = "https://example.com/page";
const WAYBACK_URL = `https://web.archive.org/web/2id_/${PAGE_URL}`;

class FakeClock {
  t = 1_000_000;
  sleeps: number[] = [];
  now = () => this.t;
  sleep = (ms: number) => {
    this.sleeps.push(ms);
    return Promise.resolve();
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function makeDeps(clock: FakeClock, fake: FetchLike) {
  return {
    fetch: fake,
    sleep: clock.sleep,
    now: clock.now,
    state: createHttpState(),
    dir: mkdtempSync(join(tmpdir(), "qany-fetch-")),
  };
}

function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return fn().then(
    (result) => {
      console.error = original;
      return { result, logs };
    },
    (err) => {
      console.error = original;
      throw err;
    },
  );
}

describe("extractReadable", () => {
  test("extracts the title and readable text, dropping noise elements", async () => {
    const { title, text } = await extractReadable(
      FIXTURE_HTML,
      "https://example.com/page",
    );
    expect(title).toBe("Fixture & Page");
    expect(text).toContain("Hello World");
    expect(text).toContain("First paragraph with bold text.");
    for (const noise of [
      "Home | About",
      "Related links",
      "Submit form noise",
      "Copyright noise",
      "console.log",
      "color: red",
    ]) {
      expect(text).not.toContain(noise);
    }
  });

  test("collapses whitespace", async () => {
    const { text } = await extractReadable(
      FIXTURE_HTML,
      "https://example.com/page",
    );
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/\s{2,}/);
  });

  test("falls back to whole-document text when the body has none", async () => {
    const html = `<html><head><title>Only</title></head><body><script>junk</script></body></html>`;
    const { text } = await extractReadable(html, "https://example.com/");
    expect(text).toBe("Only");
  });

  test("strips escaped structural markup and a11y chrome from title and text", async () => {
    const html = [
      "<html><head>",
      "<title>Press release: Nobel Prize in Physics 2026 - NobelPrize.org",
      "Open the search menuClose the search menu</title>",
      "</head><body>",
      "&lt;h3&gt; Enhanced Page Navigation &lt;/h3&gt; &lt;ol&gt; &lt;li&gt; ",
      "&lt;a href=&quot;/prizes/&quot;&gt;All prizes&lt;/a&gt; ",
      "The Nobel Prize in Physics 2026 has been awarded to Francis Halzen ",
      "for decisive contributions to the IceCube Neutrino Observatory.",
      "</body></html>",
    ].join("");
    const { title, text } = await extractReadable(
      html,
      "https://www.nobelprize.org/x",
    );
    expect(title).toBe(
      "Press release: Nobel Prize in Physics 2026 - NobelPrize.org",
    );
    expect(text).toContain("Francis Halzen");
    expect(text).toContain("IceCube Neutrino Observatory");
    expect(text).not.toContain("<h3>");
    expect(text).not.toContain("<ol>");
    expect(text).not.toContain("Enhanced Page Navigation");
    expect(text).not.toContain("search menu");
  });

  test("keeps generic code text with angle brackets", async () => {
    const html = [
      "<html><head><title>Comparisons &amp; templating</title></head><body>",
      "<p>Guard your bounds with a &lt; b and generic &lt;T&gt; helpers.</p>",
      "</body></html>",
    ].join("");
    const { title, text } = await extractReadable(
      html,
      "https://example.com/code",
    );
    expect(title).toBe("Comparisons & templating");
    expect(text).toContain("a < b");
    expect(text).toContain("generic <T> helpers");
  });

  test("strips a skip link when the a11y chrome leaks as text", async () => {
    const html = [
      "<html><head><title>Docs</title></head><body>",
      "<p>&lt;a href=&quot;#main&quot;&gt;Skip to main content&lt;/a&gt; Real docs begin.</p>",
      "</body></html>",
    ].join("");
    const { text } = await extractReadable(html, "https://example.com/docs");
    expect(text).toContain("Real docs begin.");
    expect(text).not.toContain("Skip to main content");
  });

  test("uses the hostname as title when the page has none", async () => {
    const { title } = await extractReadable(
      "<body><p>hi</p></body>",
      "https://example.com/x",
    );
    expect(title).toBe("example.com");
  });

  test("prefers main content and drops the chrome outside it", async () => {
    const html = [
      "<html><head><title>Article</title></head><body>",
      '<ul class="a11y-menu"><li><a href="#content">Skip to main content</a></li></ul>',
      "<header>Site header nav junk</header>",
      "<main><h1>Real heading</h1><p>The real article text lives here.</p></main>",
      "</body></html>",
    ].join("");
    const { text } = await extractReadable(html, "https://example.com/a");
    expect(text).toContain("The real article text lives here.");
    expect(text).not.toContain("Skip to main content");
    expect(text).not.toContain("Site header nav junk");
  });

  test("falls back to article when there is no main", async () => {
    const html =
      "<body><div>chrome around</div><article><p>Article body text.</p></article></body>";
    const { text } = await extractReadable(html, "https://example.com/b");
    expect(text).toContain("Article body text.");
    expect(text).not.toContain("chrome around");
  });

  test("ignores a trivial main and keeps the body text", async () => {
    const html = "<body><p>Full body story text.</p><main></main></body>";
    const { text } = await extractReadable(html, "https://example.com/c");
    expect(text).toContain("Full body story text.");
  });
});

describe("fetchPage", () => {
  test("fetches HTML directly and extracts readable text", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const fake: FetchLike = async (input) => {
      calls.push(String(input));
      return htmlResponse(FIXTURE_HTML);
    };
    const page = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake));
    expect(page.via).toBe("direct");
    expect(page.url).toBe(PAGE_URL);
    expect(page.title).toBe("Fixture & Page");
    expect(page.text).toContain("Hello World");
    expect(page.truncated).toBe(false);
    expect(calls).toEqual([PAGE_URL]);
  });

  test("truncates text at maxChars", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async () => htmlResponse(FIXTURE_HTML);
    const page = await fetchPage(
      PAGE_URL,
      { maxChars: 20 },
      makeDeps(clock, fake),
    );
    expect(page.text.length).toBe(20);
    expect(page.truncated).toBe(true);
  });

  test("falls back to wayback when direct fails", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const fake: FetchLike = async (input) => {
      const u = String(input);
      calls.push(u);
      if (u === PAGE_URL) return htmlResponse("blocked", 403);
      return htmlResponse(FIXTURE_HTML);
    };
    const page = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake));
    expect(page.via).toBe("wayback");
    expect(page.url).toBe(PAGE_URL);
    expect(page.text).toContain("Hello World");
    expect(calls).toEqual([PAGE_URL, PAGE_URL, WAYBACK_URL]);
  });

  test("treats challenge-marked responses as failures", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async (input) => {
      const u = String(input);
      if (u === PAGE_URL)
        return htmlResponse(
          `<html><body>anomaly-modal duckduckgo.com/anomaly</body></html>`,
        );
      return htmlResponse(FIXTURE_HTML);
    };
    const page = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake));
    expect(page.via).toBe("wayback");
  });

  test("rejects with both attempt reasons when everything fails", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async (input) => {
      const u = String(input);
      if (u === PAGE_URL) return htmlResponse("blocked", 403);
      return new Response("gone", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    };
    const err = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(PAGE_URL);
    expect(err!.message).toContain("direct: HTTP 403");
    expect(err!.message).toContain("wayback: HTTP 404");
  });

  test("serves a fresh cache entry without fetching again", async () => {
    const clock = new FakeClock();
    let fetchCount = 0;
    const fake: FetchLike = async () => {
      fetchCount += 1;
      return htmlResponse(FIXTURE_HTML);
    };
    const deps = makeDeps(clock, fake);
    const first = await fetchPage(PAGE_URL, {}, deps);
    expect(first.via).toBe("direct");
    const second = await fetchPage(PAGE_URL, {}, deps);
    expect(second.via).toBe("cache");
    expect(second.text).toContain("Hello World");
    expect(second.truncated).toBe(false);
    expect(fetchCount).toBe(1);
  });

  test("serves a stale cache entry when both attempts fail", async () => {
    const clock = new FakeClock();
    const okFetch: FetchLike = async () => htmlResponse(FIXTURE_HTML);
    const deps = makeDeps(clock, okFetch);
    const first = await fetchPage(PAGE_URL, {}, deps);
    expect(first.via).toBe("direct");

    clock.t += 21_600_001;
    const failFetch: FetchLike = async (input) => {
      const u = String(input);
      if (u === PAGE_URL) return htmlResponse("blocked", 403);
      return new Response("gone", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    };
    const { result, logs } = await captureStderr(() =>
      fetchPage(PAGE_URL, {}, { ...makeDeps(clock, failFetch), dir: deps.dir }),
    );
    expect(result.via).toBe("cache");
    expect(result.text).toContain("Hello World");
    expect(logs.some((line) => line.includes("serving stale page"))).toBe(true);
  });

  test("ignores page cache entries from older extractor versions", async () => {
    const clock = new FakeClock();
    const deps = makeDeps(clock, async () => htmlResponse(FIXTURE_HTML));
    await cacheSet(
      `fetch:${PAGE_URL}`,
      {
        at: clock.now(),
        page: {
          url: PAGE_URL,
          title: "Old",
          text: "STALE CHROME TEXT",
          via: "direct",
          truncated: false,
        },
      },
      21_600_000,
      deps,
    );
    const page = await fetchPage(PAGE_URL, {}, deps);
    expect(page.text).not.toContain("STALE");
    expect(page.text).toContain("Hello World");
  });

  test("returns plain text for non-HTML content", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async () =>
      new Response("plain body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const page = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake));
    expect(page.via).toBe("direct");
    expect(page.text).toBe("plain body");
    expect(page.title).toBe("example.com");
  });

  test("rejects unsupported content types", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async (input) => {
      const u = String(input);
      if (u === PAGE_URL)
        return new Response("PNG", {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      return new Response("gone", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    };
    const err = await fetchPage(PAGE_URL, {}, makeDeps(clock, fake)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toContain(
      `direct: unsupported content-type "image/png"`,
    );
  });

  test("rejects non-http(s) schemes without calling fetch", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const fake: FetchLike = async (input) => {
      calls.push(String(input));
      return htmlResponse(FIXTURE_HTML);
    };
    const err = await fetchPage(
      "file:///etc/passwd",
      {},
      makeDeps(clock, fake),
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('unsupported URL scheme "file:"');
    expect(calls).toEqual([]);
  });

  test("rejects an unparseable URL", async () => {
    const clock = new FakeClock();
    const fake: FetchLike = async () => htmlResponse(FIXTURE_HTML);
    const err = await fetchPage("not a url", {}, makeDeps(clock, fake)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("invalid URL");
  });
});
