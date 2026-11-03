import { describe, expect, test } from "bun:test";
import { classifyIntent, engineWeight } from "../src/intent";

describe("classifyIntent", () => {
  test("dev signals win", () => {
    expect(classifyIntent("how do async iterators work in javascript")).toBe(
      "dev",
    );
    expect(classifyIntent("python 3.13 release notes 2025")).toBe("dev");
    expect(classifyIntent("bun runtime")).toBe("dev");
  });

  test("academic signals beat news years", () => {
    expect(classifyIntent("attention mechanism survey 2025")).toBe("academic");
    expect(classifyIntent("study of transformer scaling laws")).toBe(
      "academic",
    );
  });

  test("news signals", () => {
    expect(classifyIntent("egypt tax laws 2025")).toBe("news");
    expect(classifyIntent("egypt tax laws")).toBe("news");
    expect(classifyIntent("parliament election results")).toBe("news");
  });

  test("general fallback", () => {
    expect(classifyIntent("best pizza in rome")).toBe("general");
    expect(classifyIntent("weather in cairo")).toBe("general");
  });

  test("a request for a manual is a dev request", () => {
    expect(classifyIntent("tree-sitter grammar documentation")).toBe("dev");
    expect(classifyIntent("postgres explain analyze documentation")).toBe(
      "dev",
    );
    expect(classifyIntent("sqlite json functions documentation")).toBe("dev");
    expect(classifyIntent("rest api reference")).toBe("dev");
  });
});

describe("engineWeight", () => {
  test("news intent lifts the news engine above academic and wiki lists", () => {
    expect(engineWeight("news", "news")).toBeGreaterThan(
      engineWeight("news", "openalex"),
    );
    expect(engineWeight("news", "news")).toBeGreaterThan(
      engineWeight("news", "wiki"),
    );
  });

  test("dev intent lifts docs and repos above papers", () => {
    expect(engineWeight("dev", "github")).toBeGreaterThan(
      engineWeight("dev", "arxiv"),
    );
    expect(engineWeight("dev", "mdn")).toBeGreaterThan(
      engineWeight("dev", "arxiv"),
    );
  });

  test("unknown engines default to 1 and general intent is neutral", () => {
    expect(engineWeight("news", "default")).toBe(1);
    expect(engineWeight("general", "mdn")).toBe(1);
    expect(engineWeight("general", "openalex")).toBe(1);
  });
});
