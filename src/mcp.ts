import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fetchPage } from "./fetch";
import { corpusSearch, discriminativeQuery } from "./corpus";
import { formatPageText, formatResultsText } from "./format";
import { search } from "./search";
import type {
  FetchedPage,
  PageOptions,
  SearchOptions,
  SearchResult,
} from "./types";

export const SUPPORTED_PROTOCOL_VERSIONS: string[] = ["2026-07-28"];
export const LEGACY_PROTOCOL_VERSIONS: string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    );
    const version =
      typeof pkg === "object" && pkg !== null
        ? (pkg as { version?: unknown }).version
        : undefined;
    return typeof version === "string" && version.length > 0
      ? version
      : "0.0.0";
  } catch (err) {
    console.error(
      `qany: could not read package.json version: ${err instanceof Error ? err.message : err}`,
    );
    return "0.0.0";
  }
}

export const VERSION = readVersion();

const SERVER_NAME = "qany";
const DISCOVERY_TTL_MS = 300_000;

const INSTRUCTIONS =
  "qany searches the web through keyless engines (DuckDuckGo, Brave, Bing, Bing News, Hacker News, Wikipedia, MDN, Stack Overflow, GitHub, npm, arXiv, OpenAlex) and fetches pages as readable text. Call search to find pages, more to find pages like a URL you liked, recall to search pages qany read before, then fetch to read one.";

export interface McpDeps {
  search: (query: string, opts?: SearchOptions) => Promise<SearchResult[]>;
  fetchPage: (url: string, opts?: PageOptions) => Promise<FetchedPage>;
  corpusSearch: (query: string, num: number) => Promise<SearchResult[]>;
  version: string;
}

const TOOLS = [
  {
    name: "search",
    title: "Web search",
    description:
      "Search the web through keyless engines (DuckDuckGo, Brave, Bing, Bing News, Hacker News, Wikipedia, MDN, Stack Overflow, GitHub, npm, arXiv, OpenAlex). Returns numbered results with title, URL, and a short snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        num: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 8,
          description: "Maximum number of results.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "more",
    title: "Find similar pages",
    description:
      "Fetch a URL you like and search for pages like it. Extracts the page's distinctive terms (weighted against your local reading corpus) and searches the keyless engines plus the corpus with them.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL of the page to find similar pages for.",
        },
        num: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 8,
          description: "Maximum number of results.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "recall",
    title: "Search your reading corpus",
    description:
      "Search only the local corpus: pages qany fetched before through search, more, or fetch. Works offline, returns passages from your own reading history.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        num: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 8,
          description: "Maximum number of results.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    title: "Read a web page",
    description:
      "Fetch a URL and return its readable text, falling back to the Wayback Machine when the live page fails. Keyless, no API keys.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page URL." },
        max_chars: {
          type: "integer",
          minimum: 1,
          default: 20000,
          description: "Maximum characters of page text to return.",
        },
      },
      required: ["url"],
    },
  },
];

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function err(id: unknown, code: number, message: string, data?: unknown) {
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id, error };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function callTool(id: unknown, params: unknown, deps: McpDeps) {
  const paramsRec = asRecord(params);
  const name = paramsRec?.name;
  const args = asRecord(paramsRec?.arguments) ?? {};

  if (name === "search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") {
      return ok(id, {
        resultType: "complete",
        content: [
          { type: "text", text: "search requires a non-empty query string" },
        ],
        isError: true,
      });
    }
    const num =
      typeof args.num === "number" && Number.isFinite(args.num)
        ? Math.min(20, Math.max(1, Math.floor(args.num)))
        : 8;
    try {
      const results = await deps.search(query, { num });
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: formatResultsText(results, query) }],
        isError: false,
      });
    } catch (e) {
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: `search failed: ${messageOf(e)}` }],
        isError: true,
      });
    }
  }

  if (name === "more") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (url === "") {
      return ok(id, {
        resultType: "complete",
        content: [
          { type: "text", text: "more requires a non-empty url string" },
        ],
        isError: true,
      });
    }
    const num =
      typeof args.num === "number" && Number.isFinite(args.num)
        ? Math.min(20, Math.max(1, Math.floor(args.num)))
        : 8;
    try {
      const page = await deps.fetchPage(url, { maxChars: 20000 });
      const terms = discriminativeQuery(page.text);
      if (terms === "") {
        return ok(id, {
          resultType: "complete",
          content: [
            {
              type: "text",
              text: "more failed: could not extract query terms from that page",
            },
          ],
          isError: true,
        });
      }
      const results = await deps.search(terms, { num });
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: formatResultsText(results, terms) }],
        isError: false,
      });
    } catch (e) {
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: `more failed: ${messageOf(e)}` }],
        isError: true,
      });
    }
  }

  if (name === "recall") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") {
      return ok(id, {
        resultType: "complete",
        content: [
          { type: "text", text: "recall requires a non-empty query string" },
        ],
        isError: true,
      });
    }
    const num =
      typeof args.num === "number" && Number.isFinite(args.num)
        ? Math.min(20, Math.max(1, Math.floor(args.num)))
        : 8;
    try {
      const results = await deps.corpusSearch(query, num);
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: formatResultsText(results, query) }],
        isError: false,
      });
    } catch (e) {
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: `recall failed: ${messageOf(e)}` }],
        isError: true,
      });
    }
  }

  if (name === "fetch") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (url === "") {
      return ok(id, {
        resultType: "complete",
        content: [
          { type: "text", text: "fetch requires a non-empty url string" },
        ],
        isError: true,
      });
    }
    const maxChars =
      typeof args.max_chars === "number" && Number.isFinite(args.max_chars)
        ? Math.max(1, Math.floor(args.max_chars))
        : 20000;
    try {
      const page = await deps.fetchPage(url, { maxChars });
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: formatPageText(page) }],
        isError: false,
      });
    } catch (e) {
      return ok(id, {
        resultType: "complete",
        content: [{ type: "text", text: `fetch failed: ${messageOf(e)}` }],
        isError: true,
      });
    }
  }

  return err(id, -32602, `Unknown tool: ${String(name)}`);
}

export function createMcpHandler(deps: McpDeps) {
  return async function handle(msg: unknown): Promise<any | null> {
    const rec = asRecord(msg);
    if (!rec) {
      return null;
    }
    const { id, method, params } = rec;
    if (typeof method !== "string") {
      return null;
    }
    if (method.startsWith("notifications/")) {
      return null;
    }
    if (id === undefined || id === null) {
      return null;
    }

    const paramsRec = asRecord(params);
    const meta = asRecord(paramsRec?._meta);
    const protocolVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
    if (
      typeof protocolVersion === "string" &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
    ) {
      return err(
        id,
        -32022,
        `Unsupported protocol version: ${protocolVersion}`,
        {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested: protocolVersion,
        },
      );
    }

    switch (method) {
      case "initialize": {
        const clientVersion = paramsRec?.protocolVersion;
        const version =
          typeof clientVersion === "string" &&
          LEGACY_PROTOCOL_VERSIONS.includes(clientVersion)
            ? clientVersion
            : LEGACY_PROTOCOL_VERSIONS[0];
        return ok(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: deps.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok(
          id,
          typeof protocolVersion === "string" ? { resultType: "complete" } : {},
        );
      case "server/discover":
        return ok(id, {
          resultType: "complete",
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          ttlMs: DISCOVERY_TTL_MS,
          cacheScope: "public",
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: SERVER_NAME,
              version: deps.version,
            },
          },
        });
      case "tools/list":
        return ok(id, {
          resultType: "complete",
          tools: TOOLS,
          ttlMs: DISCOVERY_TTL_MS,
          cacheScope: "public",
        });
      case "tools/call":
        return callTool(id, params, deps);
      default:
        return err(id, -32601, `Unknown method: ${method}`);
    }
  };
}

export async function main(): Promise<void> {
  const handle = createMcpHandler({
    search,
    fetchPage,
    corpusSearch: async (query, num) => corpusSearch(query, {}).slice(0, num),
    version: VERSION,
  });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.error("qany: skipped malformed JSON input line");
      continue;
    }
    const response = await handle(msg);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}
