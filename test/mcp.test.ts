import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler, VERSION } from "../src/mcp";
import type {
  FetchedPage,
  PageOptions,
  SearchOptions,
  SearchResult,
} from "../src/types";

const RESULTS: SearchResult[] = [
  {
    title: "Bun Docs",
    url: "https://bun.com/docs",
    snippet: "Fast runtime",
    engine: "ddg",
  },
  {
    title: "Bun Blog",
    url: "https://bun.com/blog",
    snippet: "Release notes",
    engine: "bing",
  },
];

const PAGE: FetchedPage = {
  url: "https://example.com",
  title: "Example Domain",
  text: "Hello world.",
  via: "direct",
  truncated: false,
};

const META = {
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
};

type SearchFn = (
  query: string,
  opts?: SearchOptions,
) => Promise<SearchResult[]>;
type FetchFn = (url: string, opts?: PageOptions) => Promise<FetchedPage>;
type CorpusFn = (query: string, num: number) => Promise<SearchResult[]>;

function makeHandler(
  deps: {
    search?: SearchFn;
    fetchPage?: FetchFn;
    corpusSearch?: CorpusFn;
    version?: string;
  } = {},
) {
  const calls: {
    search?: { query: string; num?: number };
    fetchPage?: { url: string; maxChars?: number };
    corpusSearch?: { query: string; num: number };
  } = {};
  const handle = createMcpHandler({
    search: async (query, opts) => {
      calls.search = { query, num: opts?.num };
      return deps.search ? deps.search(query, opts) : RESULTS;
    },
    fetchPage: async (url, opts) => {
      calls.fetchPage = { url, maxChars: opts?.maxChars };
      return deps.fetchPage ? deps.fetchPage(url, opts) : PAGE;
    },
    corpusSearch: async (query, num) => {
      calls.corpusSearch = { query, num };
      return deps.corpusSearch ? deps.corpusSearch(query, num) : [];
    },
    version: deps.version ?? "0.2.0",
  });
  return { handle, calls };
}

describe("initialize (legacy era)", () => {
  test("echoes a known legacy client protocol version and reports server info", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo).toEqual({ name: "qany", version: "0.2.0" });
    expect(typeof res.result.instructions).toBe("string");
  });

  test("echoes the oldest known legacy version", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-10-07",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(res.result.protocolVersion).toBe("2024-10-07");
  });

  test("answers modern and unknown client versions with the latest legacy version", async () => {
    const { handle } = makeHandler();
    for (const requested of ["2026-07-28", "1999-01-01"]) {
      const res = await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: requested,
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      expect(res.result.protocolVersion).toBe("2025-11-25");
    }
  });

  test("notifications/initialized gets no response", async () => {
    const { handle } = makeHandler();
    expect(
      await handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });
});

describe("modern era (2026-07-28 stateless)", () => {
  test("server/discover reports supported versions and server info in _meta", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "server/discover",
      params: { ...META },
    });
    expect(res.result.resultType).toBe("complete");
    expect(res.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(res.result.ttlMs).toBeGreaterThan(0);
    expect(res.result.cacheScope).toBe("public");
    expect(res.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "qany",
      version: "0.2.0",
    });
  });

  test("tools/list returns search, more, and fetch schemas", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { ...META },
    });
    expect(res.result.resultType).toBe("complete");
    expect(res.result.ttlMs).toBeGreaterThan(0);
    expect(res.result.cacheScope).toBe("public");
    expect(res.result.tools).toHaveLength(4);
    const search = res.result.tools.find(
      (t: { name: string }) => t.name === "search",
    );
    const more = res.result.tools.find(
      (t: { name: string }) => t.name === "more",
    );
    const recall = res.result.tools.find(
      (t: { name: string }) => t.name === "recall",
    );
    const fetch = res.result.tools.find(
      (t: { name: string }) => t.name === "fetch",
    );
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(search.inputSchema.properties.num.maximum).toBe(20);
    expect(more.inputSchema.required).toEqual(["url"]);
    expect(more.inputSchema.properties.num.maximum).toBe(20);
    expect(recall.inputSchema.required).toEqual(["query"]);
    expect(recall.inputSchema.properties.num.maximum).toBe(20);
    expect(fetch.inputSchema.required).toEqual(["url"]);
    expect(fetch.inputSchema.properties.max_chars.default).toBe(20000);
  });

  test("rejects a bad protocol version with -32022", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" },
      },
    });
    expect(res.error.code).toBe(-32022);
    expect(res.error.data.supported).toEqual(["2026-07-28"]);
    expect(res.error.data.requested).toBe("1999-01-01");
  });

  test("unknown method gets -32601", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "bogus/method",
      params: { ...META },
    });
    expect(res.error.code).toBe(-32601);
  });

  test("answers legacy ping with an empty result", async () => {
    const { handle } = makeHandler();
    const res = await handle({ jsonrpc: "2.0", id: 11, method: "ping" });
    expect(res.result).toEqual({});
  });

  test("answers modern ping with a complete result", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 12,
      method: "ping",
      params: { ...META },
    });
    expect(res.result).toEqual({ resultType: "complete" });
  });
});

describe("tools/call", () => {
  test("search returns formatted results with default num", async () => {
    const { handle, calls } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "search", arguments: { query: "bun" }, ...META },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].type).toBe("text");
    expect(res.result.content[0].text).toContain("1. Bun Docs");
    expect(res.result.content[0].text).toContain("https://bun.com/docs");
    expect(calls.search).toEqual({ query: "bun", num: 8 });
  });

  test("search passes an explicit num through", async () => {
    const { handle, calls } = makeHandler();
    await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", arguments: { query: "bun", num: 3 }, ...META },
    });
    expect(calls.search).toEqual({ query: "bun", num: 3 });
  });

  test("fetch returns the formatted page with default max_chars", async () => {
    const { handle, calls } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
        ...META,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("# Example Domain");
    expect(calls.fetchPage).toEqual({
      url: "https://example.com",
      maxChars: 20000,
    });
  });

  test("fetch failure returns isError true with the message", async () => {
    const { handle } = makeHandler({
      fetchPage: async () => {
        throw new Error(
          "could not fetch https://example.com (direct: HTTP 403; wayback: HTTP 404)",
        );
      },
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: { url: "https://example.com" },
        ...META,
      },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("HTTP 403");
  });

  test("more fetches the page and searches with its discriminative terms", async () => {
    const { handle, calls } = makeHandler({
      fetchPage: async () => ({
        ...PAGE,
        text: "async iterators promises queue drains async iterators",
      }),
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "more",
        arguments: { url: "https://example.com" },
        ...META,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(calls.fetchPage).toEqual({
      url: "https://example.com",
      maxChars: 20000,
    });
    expect(calls.search!.query).toContain("async");
    expect(calls.search!.query).toContain("iterators");
    expect(calls.search!.num).toBe(8);
    expect(res.result.content[0].text).toContain("1. Bun Docs");
  });

  test("more with an empty page text returns an isError result", async () => {
    const { handle } = makeHandler({
      fetchPage: async () => ({ ...PAGE, text: "   " }),
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "more",
        arguments: { url: "https://example.com" },
        ...META,
      },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("query terms");
  });

  test("recall searches only the local corpus", async () => {
    const { handle, calls } = makeHandler({
      corpusSearch: async (query, num) => {
        calls.corpusSearch = { query, num };
        return [RESULTS[0]!];
      },
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "iterators" }, ...META },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("1. Bun Docs");
    expect(calls.corpusSearch).toEqual({ query: "iterators", num: 8 });
    expect(calls.search).toBeUndefined();
  });

  test("unknown tool gets -32602", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "nope", arguments: {}, ...META },
    });
    expect(res.error.code).toBe(-32602);
  });

  test("non-object arguments return an isError result", async () => {
    const { handle } = makeHandler();
    const res = await handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "search", arguments: "not an object", ...META },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("version", () => {
  test("VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
  });
});

describe("malformed input", () => {
  test("null and non-object messages get null without throwing", async () => {
    const { handle } = makeHandler();
    expect(await handle(null)).toBeNull();
    expect(await handle("not json")).toBeNull();
    expect(await handle(undefined)).toBeNull();
  });
});
