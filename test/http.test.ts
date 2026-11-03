import { describe, expect, test } from "bun:test";
import {
  createHttpState,
  isChallengeResponse,
  politeFetch,
  type HttpDeps,
} from "../src/http";

class FakeClock {
  t = 0;
  sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

function mkDeps(over: Partial<HttpDeps> = {}): HttpDeps {
  return { state: createHttpState(), ...over };
}

function ok(body = "<html>ok</html>"): Response {
  return new Response(body, { status: 200 });
}

function anomalyPage(): Response {
  return new Response(
    '<form action="//duckduckgo.com/anomaly.js"><div class="anomaly-modal">',
    { status: 200 },
  );
}

test("politeFetch preserves binary bodies through challenge inspection", async () => {
  const payload = new Uint8Array([0x78, 0x9c, 0xff, 0xfe, 0x00, 0x01, 0x80]);
  const deps = mkDeps({
    fetch: async () => new Response(payload, { status: 200 }),
    sleep: async () => {},
    now: () => 0,
  });
  const res = await politeFetch("https://binary.example/objects.inv", {}, deps);
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...payload]);
});

describe("isChallengeResponse", () => {
  test("treats 202, 403, and 429 as challenges", () => {
    expect(isChallengeResponse(202, "")).toBe(true);
    expect(isChallengeResponse(403, "")).toBe(true);
    expect(isChallengeResponse(429, "")).toBe(true);
  });

  test("detects the DDG anomaly page body", () => {
    expect(
      isChallengeResponse(200, '<form action="//duckduckgo.com/anomaly.js">'),
    ).toBe(true);
    expect(isChallengeResponse(200, '<div class="anomaly-modal__check">')).toBe(
      true,
    );
  });

  test("does not flag a normal page that merely mentions the word challenge", () => {
    expect(
      isChallengeResponse(
        200,
        "<html><h1>30 day challenge results</h1></html>",
      ),
    ).toBe(false);
    expect(isChallengeResponse(200, "<html>ordinary results</html>")).toBe(
      false,
    );
  });
});

describe("politeFetch", () => {
  test("retries a 202 challenge and returns the 200", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps = mkDeps({
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return calls === 1 ? new Response("", { status: 202 }) : ok();
      },
    });
    const res = await politeFetch("https://example.com/a", {}, deps);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(400);
  });

  test("does not retry a normal 200", async () => {
    let calls = 0;
    const deps = mkDeps({
      fetch: async () => {
        calls += 1;
        return ok();
      },
    });
    const res = await politeFetch("https://example.com/a", {}, deps);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("retries a 200 response whose body is an anomaly page", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps = mkDeps({
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return calls === 1 ? anomalyPage() : ok();
      },
    });
    const res = await politeFetch("https://example.com/a", {}, deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>ok</html>");
    expect(calls).toBe(2);
  });

  test("probes only a capped prefix of a large body", async () => {
    const chunkSize = 16_384;
    const totalChunks = 64;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize).fill(97));
      },
    });
    const deps = mkDeps({
      fetch: async () => new Response(body, { status: 200 }),
    });
    const res = await politeFetch("https://example.com/big", {}, deps);
    expect(res.status).toBe(200);
    expect(pulls).toBeLessThan(5);
    expect((await res.text()).length).toBe(chunkSize * totalChunks);
  });

  test("spaces requests to the same host by the minimum interval", async () => {
    const clock = new FakeClock();
    const startTimes: number[] = [];
    const deps = mkDeps({
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        startTimes.push(clock.now());
        return ok();
      },
    });
    await Promise.all([
      politeFetch("https://example.com/a", { minIntervalMs: 1000 }, deps),
      politeFetch("https://example.com/b", { minIntervalMs: 1000 }, deps),
    ]);
    expect(startTimes.length).toBe(2);
    expect(startTimes[1]! - startTimes[0]!).toBe(1000);
    expect(clock.sleeps).toEqual([1000]);
  });

  test("serializes same-host requests behind an in-flight request", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const deps = mkDeps({
      fetch: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return ok();
      },
    });
    const first = politeFetch("https://example.com/a", {}, deps);
    const second = politeFetch("https://example.com/b", {}, deps);
    try {
      await Bun.sleep(5);
      expect(calls).toBe(1);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });

  test("does not serialize different hosts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const deps = mkDeps({
      fetch: async () => {
        calls += 1;
        await gate;
        return ok();
      },
    });
    const first = politeFetch("https://a.example.com/", {}, deps);
    const second = politeFetch("https://b.example.com/", {}, deps);
    try {
      await Bun.sleep(5);
      expect(calls).toBe(2);
    } finally {
      release();
    }
    await Promise.all([first, second]);
  });

  test("returns the last challenge response once retries are exhausted", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps = mkDeps({
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 202 });
      },
    });
    const res = await politeFetch(
      "https://example.com/a",
      { retries: 1 },
      deps,
    );
    expect(res.status).toBe(202);
    expect(calls).toBe(2);
  });

  test("retries network errors, then throws with the URL in the message", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const deps = mkDeps({
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        throw new TypeError("connection reset");
      },
    });
    const promise = politeFetch(
      "https://example.com/broken",
      { retries: 1 },
      deps,
    );
    await expect(promise).rejects.toThrow("https://example.com/broken");
    expect(calls).toBe(2);
  });
});
