// Official documentation hosts, keyed by the product a question names.
//
// A dev question about a product has one canonical manual. Search engines
// often answer with a community answer and bury the manual under it, and the
// title-and-URL relevance gate drops the manual before any page is read. This
// module names the manual so the search can put it in front of the page
// evidence pass, which then decides the order from the page body.
//
// The mapping is deliberately narrow: a product name earns its own host, not
// a class of hosts. "postgres" points at postgresql.org, not at every blog
// that writes about postgres.
export interface DocSite {
  /** Product names in the question that point at this site. */
  product: RegExp;
  /** Hosts that serve the documentation. */
  hosts: string[];
}

export const DOC_SITES: DocSite[] = [
  { product: /\btypescript\b/, hosts: ["typescriptlang.org"] },
  {
    product: /\b(?:javascript|ecmascript)\b/,
    hosts: ["developer.mozilla.org", "tc39.es"],
  },
  { product: /\bnode(?:\.?js)?\b/, hosts: ["nodejs.org"] },
  { product: /\bbun\b/, hosts: ["bun.com"] },
  { product: /\bdeno\b/, hosts: ["docs.deno.com"] },
  { product: /\breact\b/, hosts: ["react.dev", "reactjs.org"] },
  { product: /\bnext(?:\.?js)?\b/, hosts: ["nextjs.org"] },
  { product: /\bvue(?:\.js)?\b/, hosts: ["vuejs.org"] },
  { product: /\bsvelte(?:kit)?\b/, hosts: ["svelte.dev"] },
  { product: /\bangular\b/, hosts: ["angular.dev"] },
  { product: /\bsolid\.?js\b/, hosts: ["solidjs.com"] },
  { product: /\bastro\b/, hosts: ["docs.astro.build"] },
  { product: /\bpython\b/, hosts: ["docs.python.org"] },
  { product: /\bdjango\b/, hosts: ["docs.djangoproject.com"] },
  { product: /\bflask\b/, hosts: ["flask.palletsprojects.com"] },
  { product: /\bfastapi\b/, hosts: ["fastapi.tiangolo.com"] },
  { product: /\brust\b|\bcargo\b/, hosts: ["doc.rust-lang.org", "docs.rs"] },
  { product: /\bgo(?:lang)?\b/, hosts: ["go.dev", "pkg.go.dev"] },
  { product: /\bjava\b/, hosts: ["docs.oracle.com", "dev.java"] },
  { product: /\bkotlin\b/, hosts: ["kotlinlang.org"] },
  { product: /\bswift\b/, hosts: ["developer.apple.com", "swift.org"] },
  { product: /\bruby\b/, hosts: ["ruby-doc.org", "docs.ruby-lang.org"] },
  { product: /\brails\b/, hosts: ["guides.rubyonrails.org"] },
  { product: /\bphp\b/, hosts: ["php.net"] },
  { product: /\blaravel\b/, hosts: ["laravel.com"] },
  { product: /\b(?:dotnet|\.net|c#|csharp)\b/, hosts: ["learn.microsoft.com"] },
  { product: /\bpostgres(?:ql)?\b/, hosts: ["postgresql.org"] },
  { product: /\bmysql\b/, hosts: ["dev.mysql.com"] },
  { product: /\bsqlite\b/, hosts: ["sqlite.org"] },
  { product: /\bmongo(?:db)?\b/, hosts: ["mongodb.com"] },
  { product: /\bredis\b/, hosts: ["redis.io"] },
  { product: /\bdocker\b/, hosts: ["docs.docker.com"] },
  { product: /\bkubernetes\b|\bk8s\b/, hosts: ["kubernetes.io"] },
  { product: /\bterraform\b/, hosts: ["developer.hashicorp.com"] },
  { product: /\baws\b/, hosts: ["docs.aws.amazon.com"] },
  { product: /\blinux\b/, hosts: ["man7.org", "kernel.org"] },
  { product: /\bcss\b/, hosts: ["developer.mozilla.org"] },
  {
    product: /\bhtml\b/,
    hosts: ["developer.mozilla.org", "html.spec.whatwg.org"],
  },
  {
    product: /\bwebassembly\b|\bwasm\b/,
    hosts: ["webassembly.org", "developer.mozilla.org"],
  },
  { product: /\bgraphql\b/, hosts: ["graphql.org"] },
  { product: /\bexpress(?:\.js)?\b/, hosts: ["expressjs.com"] },
  { product: /\bfastify\b/, hosts: ["fastify.dev"] },
  { product: /\bprisma\b/, hosts: ["prisma.io"] },
  { product: /\btailwind(?:\.css)?\b/, hosts: ["tailwindcss.com"] },
  { product: /\bvite\b/, hosts: ["vite.dev"] },
  { product: /\bwebpack\b/, hosts: ["webpack.js.org"] },
  { product: /\beslint\b/, hosts: ["eslint.org"] },
  { product: /\bjest\b/, hosts: ["jestjs.io"] },
  { product: /\bvitest\b/, hosts: ["vitest.dev"] },
  { product: /\bplaywright\b/, hosts: ["playwright.dev"] },
  { product: /\bcypress\b/, hosts: ["cypress.io"] },
  { product: /\bnumpy\b/, hosts: ["numpy.org"] },
  { product: /\bpandas\b/, hosts: ["pandas.pydata.org"] },
  { product: /\bpytorch\b/, hosts: ["pytorch.org"] },
  { product: /\btensorflow\b/, hosts: ["tensorflow.org"] },
  { product: /\bspring\b/, hosts: ["docs.spring.io"] },
  { product: /\bsymfony\b/, hosts: ["symfony.com"] },
  { product: /\belixir\b/, hosts: ["hexdocs.pm"] },
  { product: /\bhaskell\b/, hosts: ["haskell.org"] },
  { product: /\bzig\b/, hosts: ["ziglang.org"] },
  { product: /\bnpm\b/, hosts: ["docs.npmjs.com"] },
  { product: /\btree-?sitter\b/, hosts: ["tree-sitter.github.io"] },
  { product: /\bgit\b/, hosts: ["git-scm.com"] },
  { product: /\bnginx\b/, hosts: ["nginx.org"] },
  { product: /\bkafka\b/, hosts: ["kafka.apache.org"] },
  { product: /\belastic(?:search)?\b/, hosts: ["elastic.co"] },
  { product: /\bprometheus\b/, hosts: ["prometheus.io"] },
  { product: /\bgrafana\b/, hosts: ["grafana.com"] },
  { product: /\bopenai\b/, hosts: ["platform.openai.com"] },
];

// Blog and announcement pages live on documentation hosts but answer a
// different question, so they never stand in for the manual.
const NON_DOC_PATH =
  /\/(?:blog|news|posts|articles|announcements|changelog|showcase|events|talks?|podcasts?|videos?)(?:\/|$)/i;

/** Documentation hosts that serve a product named in the query. */
export function officialDocHosts(query: string): string[] {
  const lower = query.toLowerCase();
  const hosts: string[] = [];
  for (const site of DOC_SITES) {
    if (!site.product.test(lower)) continue;
    for (const host of site.hosts) {
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/** True when the URL is a documentation page of a product named in the query. */
export function isOfficialDocPage(query: string, url: string): boolean {
  const hosts = officialDocHosts(query);
  if (hosts.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!hosts.includes(host)) return false;
  return !NON_DOC_PATH.test(parsed.pathname);
}
