#!/usr/bin/env bun
import { fetchPage } from "./fetch";
import { corpusSearch, discriminativeQuery } from "./corpus";
import {
  formatPageJson,
  formatPageText,
  formatResultsJson,
  formatResultsText,
} from "./format";
import { main as mcpMain } from "./mcp";
import { search } from "./search";

const NUM_DEFAULT = 8;
const NUM_MAX = 20;
const MAX_CHARS_DEFAULT = 20_000;
const PORT_DEFAULT = 8787;

export type CliCommand =
  | {
      cmd: "search";
      query: string;
      num: number;
      json: boolean;
      noCache: boolean;
      rerank?: boolean;
    }
  | { cmd: "more"; url: string; num: number; json: boolean; noCache: boolean }
  | { cmd: "recall"; query: string; num: number; json: boolean }
  | {
      cmd: "fetch";
      url: string;
      maxChars: number;
      json: boolean;
      noCache: boolean;
    }
  | { cmd: "serve"; port: number }
  | { cmd: "mcp" }
  | { cmd: "help" };

const HELP = `qany - keyless web search + page fetch for LLMs and humans

usage:
  qany search <query> [-n <num>] [--json] [--no-cache] [--rerank]
  qany more <url> [-n <num>] [--json] [--no-cache]
  qany recall <query> [-n <num>] [--json]
  qany fetch <url> [--max-chars <num>] [--json] [--no-cache]
  qany serve [-p <port>]
  qany mcp
  qany help

commands:
  search   search the web (DuckDuckGo, Brave, Bing, Bing News, Mwmbl, Hacker News, Wikipedia, MDN, Stack Overflow, GitHub, npm, arXiv, OpenAlex)
  more     find pages like the given URL (web search seeded by the page)
  recall   search only your local reading corpus (pages qany fetched before)
  fetch    fetch a page as readable text (Wayback Machine fallback)
  serve    run the HTTP API (default port 8787)
  mcp      run the MCP server on stdio

flags:
  -n, --num <n>      number of results (1-20, default 8)
  --max-chars <n>    page text cap (default 20000)
  -p, --port <n>     serve port (default 8787)
  --json             single-line JSON output
  --no-cache         skip the search cache
  --rerank           verify result pages and rank by page evidence (auto for
                     question-shaped queries)`;

function intValue(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliCommand {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return { cmd: "help" };
  }
  const rest = argv.slice(1);

  if (cmd === "search") {
    const positionals: string[] = [];
    let num = NUM_DEFAULT;
    let json = false;
    let noCache = false;
    let rerank = false;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token.startsWith("-")) {
        positionals.push(token);
        continue;
      }
      const [flag, inline] = token.split("=", 2);
      const takeValue = (): string => {
        if (inline !== undefined) {
          return inline;
        }
        i += 1;
        if (i >= rest.length) {
          throw new Error(`missing value for ${flag}`);
        }
        return rest[i];
      };
      if (flag === "-n" || flag === "--num") {
        const value = intValue(flag, takeValue());
        if (value < 1) {
          throw new Error(`invalid ${flag} value: ${value}`);
        }
        num = Math.min(NUM_MAX, value);
      } else if (flag === "--json") {
        json = true;
      } else if (flag === "--no-cache") {
        noCache = true;
      } else if (flag === "--rerank") {
        rerank = true;
      } else {
        throw new Error(`unknown flag: ${flag}`);
      }
    }
    const query = positionals.join(" ").trim();
    if (query === "") {
      throw new Error("search needs a query");
    }
    // Absent --rerank stays undefined so search() keeps its auto rule
    // (questions rerank on their own); the flag forces it on.
    return {
      cmd: "search",
      query,
      num,
      json,
      noCache,
      ...(rerank ? { rerank: true } : {}),
    };
  }

  if (cmd === "fetch") {
    const positionals: string[] = [];
    let maxChars = MAX_CHARS_DEFAULT;
    let json = false;
    let noCache = false;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token.startsWith("-")) {
        positionals.push(token);
        continue;
      }
      const [flag, inline] = token.split("=", 2);
      const takeValue = (): string => {
        if (inline !== undefined) {
          return inline;
        }
        i += 1;
        if (i >= rest.length) {
          throw new Error(`missing value for ${flag}`);
        }
        return rest[i];
      };
      if (flag === "--max-chars") {
        const value = intValue(flag, takeValue());
        if (value < 1) {
          throw new Error(`invalid ${flag} value: ${value}`);
        }
        maxChars = value;
      } else if (flag === "--json") {
        json = true;
      } else if (flag === "--no-cache") {
        noCache = true;
      } else {
        throw new Error(`unknown flag: ${flag}`);
      }
    }
    const url = positionals[0];
    if (url === undefined || url.trim() === "") {
      throw new Error("fetch needs a url");
    }
    return { cmd: "fetch", url, maxChars, json, noCache };
  }

  if (cmd === "more") {
    const positionals: string[] = [];
    let num = NUM_DEFAULT;
    let json = false;
    let noCache = false;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token.startsWith("-")) {
        positionals.push(token);
        continue;
      }
      const [flag, inline] = token.split("=", 2);
      const takeValue = (): string => {
        if (inline !== undefined) {
          return inline;
        }
        i += 1;
        if (i >= rest.length) {
          throw new Error(`missing value for ${flag}`);
        }
        return rest[i];
      };
      if (flag === "-n" || flag === "--num") {
        const value = intValue(flag, takeValue());
        if (value < 1) {
          throw new Error(`invalid ${flag} value: ${value}`);
        }
        num = Math.min(NUM_MAX, value);
      } else if (flag === "--json") {
        json = true;
      } else if (flag === "--no-cache") {
        noCache = true;
      } else {
        throw new Error(`unknown flag: ${flag}`);
      }
    }
    const url = positionals[0];
    if (url === undefined || url.trim() === "") {
      throw new Error("more needs a url");
    }
    return { cmd: "more", url, num, json, noCache };
  }

  if (cmd === "recall") {
    const positionals: string[] = [];
    let num = NUM_DEFAULT;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token.startsWith("-")) {
        positionals.push(token);
        continue;
      }
      const [flag, inline] = token.split("=", 2);
      const takeValue = (): string => {
        if (inline !== undefined) {
          return inline;
        }
        i += 1;
        if (i >= rest.length) {
          throw new Error(`missing value for ${flag}`);
        }
        return rest[i];
      };
      if (flag === "-n" || flag === "--num") {
        const value = intValue(flag, takeValue());
        if (value < 1) {
          throw new Error(`invalid ${flag} value: ${value}`);
        }
        num = Math.min(NUM_MAX, value);
      } else if (flag === "--json") {
        json = true;
      } else {
        throw new Error(`unknown flag: ${flag}`);
      }
    }
    const query = positionals.join(" ").trim();
    if (query === "") {
      throw new Error("recall needs a query");
    }
    return { cmd: "recall", query, num, json };
  }

  if (cmd === "serve") {
    let port = PORT_DEFAULT;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      const [flag, inline] = token.split("=", 2);
      if (flag === "-p" || flag === "--port") {
        const raw = inline !== undefined ? inline : rest[++i];
        if (raw === undefined) {
          throw new Error(`missing value for ${flag}`);
        }
        port = intValue(flag, raw);
        if (port < 1 || port > 65535) {
          throw new Error(`invalid port value: ${port}`);
        }
      } else {
        throw new Error(`unknown flag: ${flag}`);
      }
    }
    return { cmd: "serve", port };
  }

  if (cmd === "mcp") {
    for (const token of rest) {
      throw new Error(`unknown flag: ${token}`);
    }
    return { cmd: "mcp" };
  }

  throw new Error(`unknown command: ${cmd}`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function textResponse(body: string, status = 200): Response {
  return new Response(body.endsWith("\n") ? body : body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function serve(port: number): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const u = new URL(req.url);
      try {
        if (u.pathname === "/search") {
          const q = (u.searchParams.get("q") ?? "").trim();
          if (q === "") {
            return textResponse("missing q parameter", 400);
          }
          const rawN = u.searchParams.get("n");
          let n = NUM_DEFAULT;
          if (rawN !== null) {
            const parsed = Number(rawN);
            if (Number.isInteger(parsed) && parsed >= 1) {
              n = Math.min(NUM_MAX, parsed);
            }
          }
          const results = await search(q, { num: n });
          return u.searchParams.get("format") === "json"
            ? jsonResponse(formatResultsJson(results, q))
            : textResponse(formatResultsText(results, q));
        }
        if (u.pathname === "/fetch") {
          const target = (u.searchParams.get("url") ?? "").trim();
          if (target === "") {
            return textResponse("missing url parameter", 400);
          }
          const rawMax = u.searchParams.get("max_chars");
          let maxChars = MAX_CHARS_DEFAULT;
          if (rawMax !== null) {
            const parsed = Number(rawMax);
            if (Number.isInteger(parsed) && parsed >= 1) {
              maxChars = parsed;
            }
          }
          const page = await fetchPage(target, { maxChars });
          return u.searchParams.get("format") === "json"
            ? jsonResponse(formatPageJson(page))
            : textResponse(formatPageText(page));
        }
        return textResponse("qany: try /search?q=... or /fetch?url=...", 404);
      } catch (e) {
        return textResponse(`qany: ${messageOf(e)}`, 502);
      }
    },
  });
  console.log(`qany serving on http://localhost:${server.port}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const cmd = parseArgs(argv);
    switch (cmd.cmd) {
      case "help":
        console.log(HELP);
        return;
      case "search": {
        const results = await search(cmd.query, {
          num: cmd.num,
          noCache: cmd.noCache,
          rerank: cmd.rerank,
        });
        console.log(
          cmd.json
            ? formatResultsJson(results, cmd.query)
            : formatResultsText(results, cmd.query),
        );
        return;
      }
      case "fetch": {
        const page = await fetchPage(cmd.url, {
          maxChars: cmd.maxChars,
          noCache: cmd.noCache,
        });
        console.log(cmd.json ? formatPageJson(page) : formatPageText(page));
        return;
      }
      case "more": {
        const page = await fetchPage(cmd.url, { noCache: cmd.noCache });
        const terms = discriminativeQuery(page.text);
        if (terms === "") {
          console.error("qany: could not extract query terms from that page");
          return;
        }
        console.error(`qany: finding pages like this using: ${terms}`);
        const results = await search(terms, {
          num: cmd.num,
          noCache: cmd.noCache,
        });
        console.log(
          cmd.json
            ? formatResultsJson(results, terms)
            : formatResultsText(results, terms),
        );
        return;
      }
      case "recall": {
        const results = corpusSearch(cmd.query, {}).slice(0, cmd.num);
        console.log(
          cmd.json
            ? formatResultsJson(results, cmd.query)
            : formatResultsText(results, cmd.query),
        );
        return;
      }
      case "serve":
        serve(cmd.port);
        return;
      case "mcp":
        return mcpMain();
    }
  } catch (e) {
    console.error(`qany: ${messageOf(e)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
