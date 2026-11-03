// Vocabulary expansion: keyless lexical cure for the vocabulary-mismatch
// problem. When a query uses one term of a well-known pair (throttling,
// rate limiting), the counterpart terms ride along so engines can match
// pages written with either word. High-precision pairs only: a wrong add
// costs recall in every engine that runs the enriched variant.

const ALIASES: Record<string, string> = {
  throttling: "rate limiting",
  backpressure: "flow control",
  memoization: "caching",
  gc: "garbage collection",
  k8s: "kubernetes",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rbac: "role based access control",
  oauth: "authentication",
  csp: "content security policy",
  xss: "cross site scripting",
  ssrf: "server side request forgery",
  csrf: "cross site request forgery",
  rce: "remote code execution",
  regex: "regular expression",
  troubleshooting: "debug",
  debugging: "debug",
  cancellation: "cancel",
  configuration: "config",
  authentication: "auth",
  authorization: "authz",
  repository: "repo",
  asynchronous: "async",
  synchronous: "sync",
  documentation: "docs",
  installation: "install",
  deployment: "deploy",
  parameter: "param",
  argument: "arg",
  directory: "dir",
  initialize: "init",
  maximum: "max",
  minimum: "min",
};

// Two-word phrases the single-token table cannot see. Fires when both words
// of the pair appear in the query and the phrase's sibling term is missing.
const ALIAS_PAIRS: { at: [string, string]; add: string }[] = [
  { at: ["rate", "limiting"], add: "throttling" },
];

// Hard cap so an abbreviation-heavy query cannot flood engines with terms.
const MAX_ADDS = 4;

// A caret suggestion is only worth a full re-search when it keeps the query's
// vocabulary. DuckDuckGo autocomplete also serves trending phrases ("fastelavn
// bun run 2026") that share one short token with the original and would
// replace a release question with a pastry half-marathon. A spelling fix
// ("throtling" to "throttling") or a wordbreak fix ("html rewriter" in
// "htmlrewriter") must still clear the bar: multiple shared words, or one
// shared word long enough to be the query's subject.
export function sharesVocabulary(query: string, suggestion: string): boolean {
  const content = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
  const queryTokens = content(query);
  if (queryTokens.length === 0) return true;

  // Spelling fixes keep a common head and differ by a letter or two; distinct
  // words that merely start alike ("rate", "gates") share far less head.
  const near = (token: string, other: string) => {
    if (Math.abs(token.length - other.length) > 2) return false;
    let head = 0;
    while (
      head < token.length &&
      head < other.length &&
      token[head] === other[head]
    )
      head += 1;
    return head >= 4;
  };
  const matches = (queryToken: string, suggestionToken: string) =>
    queryToken === suggestionToken ||
    queryToken.includes(suggestionToken) ||
    suggestionToken.includes(queryToken) ||
    near(queryToken, suggestionToken);

  let exact = 0;
  let fuzzy = 0;
  let loneLongToken = "";
  for (const token of content(suggestion)) {
    for (const queryToken of queryTokens) {
      if (!matches(queryToken, token)) continue;
      if (queryToken === token) {
        exact += 1;
      } else {
        fuzzy += 1;
        if (queryToken.length >= 6) loneLongToken = queryToken;
      }
      break;
    }
  }
  return exact + fuzzy >= 2 || (exact + fuzzy === 1 && loneLongToken !== "");
}

export function aliasTokens(tokens: string[]): string[] {
  const present = new Set(tokens.map((token) => token.toLowerCase()));
  const added: string[] = [];
  for (const token of tokens) {
    if (added.length >= MAX_ADDS) break;
    const alias = ALIASES[token.toLowerCase()];
    if (!alias) continue;
    for (const word of alias.split(" ")) {
      if (present.has(word) || added.includes(word) || added.length >= MAX_ADDS)
        continue;
      added.push(word);
    }
  }
  for (const pair of ALIAS_PAIRS) {
    if (added.length >= MAX_ADDS) break;
    if (
      pair.at.every((word) => present.has(word)) &&
      !present.has(pair.add) &&
      !added.includes(pair.add)
    ) {
      added.push(pair.add);
    }
  }
  return added;
}
