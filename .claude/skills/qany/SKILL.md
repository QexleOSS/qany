---
name: qany
description: Search the web without an API key. Use when you need current facts, documentation, release notes, error messages, or the content of a page, and no paid search tool is available. Runs fourteen public sources behind one command and reads pages as clean text.
---

# qany

qany queries fourteen public sources, fuses their rankings, and reads the
pages that matter as plain text. No account, no key, no per-query bill.

The answers come back as title, URL and snippet. When a page needs to be read
rather than skimmed, `qany fetch` returns its text and `qany more` searches
one page for what the user asked.

## Install

```bash
bun add -g @qexle/qany
```

The same package runs with `bunx @qexle/qany` or `npx @qexle/qany`.

## Command list

| Command               | What it answers                                 |
| --------------------- | ----------------------------------------------- |
| `qany search <query>` | What the web says about a question              |
| `qany more <url>`     | What one page says, searched for the same words |
| `qany recall <query>` | What you read before, from the local corpus     |
| `qany fetch <url>`    | The page as clean text                          |
| `qany serve`          | The same search over HTTP on port 8787          |
| `qany mcp`            | The same search as an MCP server on stdio       |

`-n <num>` sets the number of results, 1 to 20, and the default is 8.
`--json` prints one line of JSON instead of text. `--no-cache` skips the
response cache. `--rerank` verifies the result pages and ranks by what the
pages say, and it runs by itself for documentation questions.

## Working method

Search with the words a person would type. qany classifies the query, picks
the source set that fits it, and expands the query when the first answer set
looks thin.

```bash
qany search "bun html rewriter documentation"
qany search "postgres explain analyze" --json
```

Read the page when the snippet is not enough. The snippet is a summary written
by someone else.

```bash
qany fetch https://bun.com/docs/runtime/html-rewriter
qany more https://bun.com/docs/runtime/html-rewriter --json
```

Search a single site when the answer belongs to one place. The `site:` operator
works, and it is the fastest way to reach an official page.

```bash
qany search "site:typescriptlang.org satisfies operator"
```

Use the MCP server when the host already speaks MCP. It exposes the same
search over stdio, so no key travels with the request.

```bash
qany mcp
```

## Rules

- Name the source when you report a fact. qany labels every answer with the
  endpoint it came from.
- Read the page before you quote it. A snippet is not a source.
- Prefer an official page over an article about one. qany lifts official
  documentation to the top for documentation questions, but a summary can
  still outrank the manual.
- Say when an engine stayed silent. A short answer set means the network took
  engines away, not that the topic is rare.
- Never invent a URL. Every path in an answer comes from a source that
  answered.
- qany reads public endpoints. Rate limits apply to the host as well as to
  qany. Keep the request count low and give the cache time to work.

## What it does not do

qany searches public pages. It does not log in anywhere, does not run code,
does not pay for a hosted index, and cannot answer a question that lives
behind a paywall or a login.
