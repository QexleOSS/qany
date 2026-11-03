import { describe, expect, test } from "bun:test";
import { bestPassage, splitPassages } from "../src/passages";

const WORD =
  "the async iterator protocol drives page draining through queue lines and other runtime details";

function noise(n: number): string {
  // Sentence filler sharing none of the probe tokens.
  return Array.from(
    { length: n },
    (_, i) =>
      `Moody bakers pour crips under warm cannon ${i}; plumbers deliver silent candles for the barrel.`,
  ).join("\n\n");
}

describe("splitPassages", () => {
  test("groups paragraphs into bounded windows", () => {
    const text = [noise(2), noise(2), noise(2)].join("\n\n");
    const passages = splitPassages(text);
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages)
      expect(passage.length).toBeLessThanOrEqual(1000);
  });

  test("splits oversized paragraphs into overlapping windows", () => {
    const big = Array.from(
      { length: 60 },
      (_, i) => `filler sentence number ${i} about nothing at all here.`,
    ).join(" ");
    const passages = splitPassages(big);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((p) => p.length <= 1000)).toBe(true);
  });
});

describe("bestPassage", () => {
  test("finds the window where query words cluster", () => {
    const text = noise(3) + "\n\n" + WORD + "\n\n" + noise(3);
    const { passage, score } = bestPassage(text, [
      "async",
      "iterator",
      "protocol",
    ]);
    expect(score).toBeGreaterThan(0);
    expect(passage).toContain("iterator");
  });

  test("scores scattered tokens far below a dense cluster", () => {
    // Same three tokens, each isolated in its own far-apart paragraph;
    // spacing exceeds one window so no window can hold two hits.
    const scattered = [
      noise(12),
      "rain explains async",
      noise(12),
      "iterator storms arrive quietly yesterday",
      noise(12),
      "the protocol diagram survives",
      noise(12),
    ].join("\n\n");
    const scatteredScore = bestPassage(scattered, [
      "async",
      "iterator",
      "protocol",
    ]).score;
    const denseScore = bestPassage(WORD, [
      "async",
      "iterator",
      "protocol",
    ]).score;
    expect(denseScore).toBeGreaterThan(scatteredScore * 2);
  });

  test("repeated token inside the cluster adds weight but repeats far away do not", () => {
    const clustered = `first intro line.\n\nthe async iterators drain queues; async iterators shine when queues drain.\n\nnoise paragraphs never mention them`;
    const { score } = bestPassage(clustered, ["async", "iterators"]);
    expect(score).toBeGreaterThan(1);
  });

  test("returns zero when no token appears", () => {
    expect(bestPassage(noise(4), ["async", "iterator"]).score).toBe(0);
  });
});
