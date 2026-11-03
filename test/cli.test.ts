import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("parseArgs search", () => {
  test("parses query, -n, and --json", () => {
    expect(
      parseArgs(["search", "bun", "runtime", "-n", "3", "--json"]),
    ).toEqual({
      cmd: "search",
      query: "bun runtime",
      num: 3,
      json: true,
      noCache: false,
    });
  });

  test("applies defaults and leaves rerank to the auto rule", () => {
    const cmd = parseArgs(["search", "bun"]);
    expect(cmd).toEqual({
      cmd: "search",
      query: "bun",
      num: 8,
      json: false,
      noCache: false,
    });
    expect(cmd.cmd === "search" && cmd.rerank).toBeUndefined();
  });

  test("supports --num=3", () => {
    const cmd = parseArgs(["search", "bun", "--num=3"]);
    expect(cmd).toEqual({
      cmd: "search",
      query: "bun",
      num: 3,
      json: false,
      noCache: false,
    });
  });

  test("parses --rerank", () => {
    const cmd = parseArgs(["search", "bun", "--rerank"]);
    expect(cmd.cmd === "search" && cmd.rerank).toBe(true);
  });

  test("parses fetch --no-cache", () => {
    const cmd = parseArgs(["fetch", "https://example.com", "--no-cache"]);
    expect(cmd.cmd === "fetch" && cmd.noCache).toBe(true);
  });

  test("clamps num above 20 and rejects num below 1", () => {
    const cmd = parseArgs(["search", "bun", "-n", "50"]);
    expect(cmd.cmd === "search" && cmd.num).toBe(20);
    expect(() => parseArgs(["search", "bun", "-n", "0"])).toThrow(
      /invalid -n value/,
    );
    expect(() => parseArgs(["search", "bun", "-n", "abc"])).toThrow(
      /invalid -n value/,
    );
  });

  test("parses --no-cache", () => {
    const cmd = parseArgs(["search", "bun", "--no-cache"]);
    expect(cmd.cmd === "search" && cmd.noCache).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["search", "bun", "--bogus"])).toThrow(
      /unknown flag/,
    );
  });

  test("rejects a missing query", () => {
    expect(() => parseArgs(["search"])).toThrow(/query/);
    expect(() => parseArgs(["search", "-n", "3"])).toThrow(/query/);
  });
});

describe("parseArgs fetch", () => {
  test("parses url and --max-chars", () => {
    expect(
      parseArgs(["fetch", "https://example.com", "--max-chars", "500"]),
    ).toEqual({
      cmd: "fetch",
      url: "https://example.com",
      maxChars: 500,
      json: false,
      noCache: false,
    });
  });

  test("applies defaults", () => {
    expect(parseArgs(["fetch", "https://example.com"])).toEqual({
      cmd: "fetch",
      url: "https://example.com",
      maxChars: 20000,
      json: false,
      noCache: false,
    });
  });

  test("rejects a missing url", () => {
    expect(() => parseArgs(["fetch"])).toThrow(/url/);
  });
});

describe("parseArgs more", () => {
  test("parses url with flags", () => {
    expect(
      parseArgs([
        "more",
        "https://example.com",
        "-n",
        "3",
        "--json",
        "--no-cache",
      ]),
    ).toEqual({
      cmd: "more",
      url: "https://example.com",
      num: 3,
      json: true,
      noCache: true,
    });
  });

  test("applies defaults", () => {
    expect(parseArgs(["more", "https://example.com"])).toEqual({
      cmd: "more",
      url: "https://example.com",
      num: 8,
      json: false,
      noCache: false,
    });
  });

  test("rejects a missing url", () => {
    expect(() => parseArgs(["more"])).toThrow(/url/);
  });
});

describe("parseArgs recall", () => {
  test("parses query with flags", () => {
    expect(
      parseArgs(["recall", "cold bootstrap", "-n", "2", "--json"]),
    ).toEqual({
      cmd: "recall",
      query: "cold bootstrap",
      num: 2,
      json: true,
    });
  });

  test("applies defaults and rejects an empty query", () => {
    expect(parseArgs(["recall", "iterators"])).toEqual({
      cmd: "recall",
      query: "iterators",
      num: 8,
      json: false,
    });
    expect(() => parseArgs(["recall"])).toThrow(/query/);
  });
});

describe("parseArgs other commands", () => {
  test("serve defaults to port 8787", () => {
    expect(parseArgs(["serve"])).toEqual({ cmd: "serve", port: 8787 });
  });

  test("serve takes -p and --port=", () => {
    expect(parseArgs(["serve", "-p", "9000"])).toEqual({
      cmd: "serve",
      port: 9000,
    });
    expect(parseArgs(["serve", "--port=9000"])).toEqual({
      cmd: "serve",
      port: 9000,
    });
  });

  test("mcp", () => {
    expect(parseArgs(["mcp"])).toEqual({ cmd: "mcp" });
  });

  test("help", () => {
    expect(parseArgs(["help"])).toEqual({ cmd: "help" });
    expect(parseArgs([])).toEqual({ cmd: "help" });
    expect(parseArgs(["--help"])).toEqual({ cmd: "help" });
    expect(parseArgs(["-h"])).toEqual({ cmd: "help" });
  });

  test("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
  });
});
