export interface PoliteInit {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
}

export interface HttpState {
  chains: Map<string, Promise<void>>;
  lastStart: Map<string, number>;
}

export function createHttpState(): HttpState {
  return { chains: new Map(), lastStart: new Map() };
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  state?: HttpState;
  /** Directory for persistent cooldown state (defaults to the cache dir). */
  dir?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MIN_INTERVAL_MS = 1_100;
const MAX_BACKOFF_MS = 10_000;

export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  "user-agent": BROWSER_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

const CHALLENGE_STATUSES = new Set([202, 403, 429, 503]);
const CHALLENGE_BODY =
  /anomaly-modal|duckduckgo\.com\/anomaly|unusual traffic|too many requests/i;

const defaultState = createHttpState();

export function isChallengeResponse(status: number, body: string): boolean {
  if (CHALLENGE_STATUSES.has(status)) return true;
  return CHALLENGE_BODY.test(body);
}

function backoffMs(attempt: number): number {
  const base = 800 * 2 ** attempt;
  const jittered = base * (0.5 + Math.random() * 0.5);
  return Math.min(Math.round(jittered), MAX_BACKOFF_MS);
}

const PROBE_LIMIT = 4_000;

async function inspectBody(
  res: Response,
): Promise<{ text: string; response: Response }> {
  const body = res.body;
  if (!body) return { text: "", response: res };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let consumed = "";
  let bytes = 0;
  try {
    while (bytes < PROBE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      bytes += value.byteLength;
      consumed += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    // A body that cannot be inspected is treated as normal content; the
    // caller still gets the response and can decide what to do.
    console.error(
      `qany: could not inspect response body: ${err instanceof Error ? err.message : err}`,
    );
    reader.releaseLock();
    return { text: "", response: res };
  }
  // Replay everything the probe consumed, then stream the rest, so the
  // returned response carries the full body the server sent. The probe is
  // replayed from the original bytes, not re-encoded text, so binary bodies
  // (sphinx inventories, images) survive intact.
  const prefix = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, at);
    at += chunk.byteLength;
  }
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const response = new Response(rest, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  return { text: consumed.slice(0, PROBE_LIMIT), response };
}

async function acquireHost(
  state: HttpState,
  host: string,
): Promise<() => void> {
  const prev = state.chains.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.chains.set(
    host,
    prev.then(() => mine),
  );
  await prev;
  return release;
}

export async function politeFetch(
  url: string,
  init: PoliteInit = {},
  deps: HttpDeps = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const state = deps.state ?? defaultState;
  const retries = init.retries ?? DEFAULT_RETRIES;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minIntervalMs = init.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const headers = { ...DEFAULT_HEADERS, ...init.headers };
  const host = new URL(url).host;

  const release = await acquireHost(state, host);
  try {
    const lastStart = state.lastStart.get(host);
    if (lastStart !== undefined) {
      const wait = minIntervalMs - (now() - lastStart);
      if (wait > 0) await sleep(wait);
    }

    let lastResponse: Response | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      state.lastStart.set(host, now());
      try {
        const res = await doFetch(url, {
          headers,
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
          redirect: "follow",
        });
        if (isChallengeResponse(res.status, "")) {
          lastResponse = res;
          lastError = new Error(
            `challenge response (HTTP ${res.status}) from ${host}`,
          );
        } else {
          const inspected = await inspectBody(res);
          if (!isChallengeResponse(res.status, inspected.text))
            return inspected.response;
          lastResponse = inspected.response;
          lastError = new Error(
            `challenge response (HTTP ${res.status}) from ${host}`,
          );
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < retries) await sleep(backoffMs(attempt));
    }

    if (lastResponse) return lastResponse;
    throw new Error(
      `qany: request to ${url} failed after ${retries + 1} attempt(s): ${lastError?.message ?? "unknown error"}`,
    );
  } finally {
    release();
  }
}
