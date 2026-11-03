import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusAdd, corpusSearch, discriminativeQuery } from "../src/corpus";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "qany-corpus-"));
}

function doc(
  url: string,
  title: string,
  text: string,
): { url: string; title: string; text: string } {
  return { url, title, text };
}

describe("corpus", () => {
  test("adds pages and finds them by BM25", () => {
    const dir = tmpDir();
    corpusAdd(
      doc(
        "https://a.example/async",
        "Async iterators explained",
        `${"async iterators work under the hood with next() returning promises. ".repeat(8)}`,
      ),
      { dir },
    );
    corpusAdd(
      doc(
        "https://b.example/egypt",
        "Egypt tax laws 2025",
        `${"egypt tax laws 2025 reform vat decree rates. ".repeat(8)}`,
      ),
      { dir },
    );
    const hits = corpusSearch("async iterators javascript", { dir });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.url).toBe("https://a.example/async");
    expect(hits[0]!.engine).toBe("corpus");
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
    const tax = corpusSearch("egypt tax laws", { dir });
    expect(tax[0]!.url).toBe("https://b.example/egypt");
  });

  test("dedupes by url keeping the newest text", () => {
    const dir = tmpDir();
    corpusAdd(
      doc(
        "https://a.example/async",
        "Async iterators",
        `${"old text async iterators. ".repeat(20)}`,
      ),
      { dir },
    );
    corpusAdd(
      doc(
        "https://a.example/async",
        "Async iterators v2",
        `${"new text async iterators promises next. ".repeat(20)}`,
      ),
      { dir },
    );
    const hits = corpusSearch("async iterators", { dir });
    expect(hits.length).toBe(1);
    expect(hits[0]!.title).toBe("Async iterators v2");
    expect(hits[0]!.snippet).toContain("new text");
  });

  test("caps the corpus and drops the oldest docs", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) {
      corpusAdd(
        doc(
          `https://x.example/${i}`,
          `Doc ${i}`,
          `${"filler token body content goes here. ".repeat(10)} uniqueword${i}`,
        ),
        { dir, maxDocs: 2 },
      );
    }
    const hits = corpusSearch("uniqueword3 uniqueword4", { dir });
    expect(hits.map((r) => r.url).sort()).toEqual([
      "https://x.example/3",
      "https://x.example/4",
    ]);
    expect(corpusSearch("uniqueword1", { dir })).toEqual([]);
  });

  test("skips thin pages and returns [] without a corpus", () => {
    const dir = tmpDir();
    corpusAdd(doc("https://t.example/thin", "Thin page", "too short"), { dir });
    expect(corpusSearch("thin page", { dir })).toEqual([]);
    expect(corpusSearch("anything", { dir: tmpDir() })).toEqual([]);
  });

  test("snippets the best matching passage, not always the text start", () => {
    const dir = tmpDir();
    const text = `${"preamble zz unrelated intro sentence. ".repeat(6)}the event loop drains microtasks before timers. ${"tail filler sentence. ".repeat(6)}`;
    corpusAdd(doc("https://e.example/loop", "Event loop internals", text), {
      dir,
    });
    const hits = corpusSearch("microtasks", { dir });
    expect(hits[0]!.snippet).toContain("microtasks");
    expect(hits[0]!.snippet).not.toContain("preamble");
  });

  test("a dense passage outranks a long page full of scattered hits", () => {
    const dir = tmpDir();
    const filler =
      "General commentary about rivers plumbing candles barrels and quiet streets. ";
    corpusAdd(
      doc(
        "https://d.example/dense",
        "Arena floor notes",
        `${"Background paperwork that keeps circling without any of the search words anywhere inside it. ".repeat(4)}\n\n` +
          "Cold bootstrap memory measurement beats startup guessing: cold and bootstrap memory set the arena floor early.\n\n" +
          `${"More unrelated closing chatter to keep the page wider than one window. ".repeat(4)}`,
      ),
      { dir },
    );
    const hitLine = "cold bootstrap memory survives tonight; ";
    corpusAdd(
      doc(
        "https://d.example/diluted",
        "General manual",
        Array.from(
          { length: 16 },
          () => `${filler.repeat(12)}\n\n${hitLine}`,
        ).join("\n\n"),
      ),
      { dir },
    );
    const hits = corpusSearch("cold bootstrap memory", { dir });
    expect(hits[0]!.url).toBe("https://d.example/dense");
  });

  test("discriminativeQuery picks page words the corpus has not seen", () => {
    const dir = tmpDir();
    corpusAdd(
      doc(
        "https://c.example/1",
        "General notes",
        `${"general commentary rivers plumbing candles barrels quiet streets. ".repeat(12)} alpha qonx`,
      ),
      { dir },
    );
    corpusAdd(
      doc(
        "https://c.example/2",
        "More notes",
        `${"general commentary rivers plumbing barrels. ".repeat(12)} bravo zulu`,
      ),
      { dir },
    );
    const example =
      "The event loop drains microtasks before timers run. Microtasks queue drains in order, " +
      "and general commentary about rivers is avoided here. microtasks microtasks microtasks";
    const terms = discriminativeQuery(example, { dir });
    expect(terms.split(" ")).toContain("microtasks");
    expect(terms.split(" ")).not.toContain("rivers");
    expect(terms.split(" ")).not.toContain("the");
  });

  test("discriminativeQuery works without a corpus and handles empty text", () => {
    const dir = tmpDir();
    const terms = discriminativeQuery(
      "async iterators promises drain queues async iterators",
      { dir },
    );
    expect(terms.split(" ")).toContain("iterators");
    expect(terms.split(" ")).toContain("async");
    expect(discriminativeQuery("   ", { dir })).toBe("");
  });
});
