import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainOf, loadTrust, recordVerdict } from "../src/trust";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "qany-trust-"));
}

describe("trust", () => {
  test("domainOf strips www and lowercases", () => {
    expect(domainOf("https://www.Example.COM/page")).toBe("example.com");
    expect(domainOf("not a url")).toBe("not a url");
  });

  test("verdicts roundtrip into a pass ratio once the sample floor is met", () => {
    const dir = tmpDir();
    recordVerdict("good.example", true, { dir });
    recordVerdict("good.example", true, { dir });
    recordVerdict("good.example", false, { dir });
    recordVerdict("shy.example", true, { dir });
    const trust = loadTrust({ dir });
    expect(trust.get("good.example")).toBeCloseTo(2 / 3);
    expect(trust.get("shy.example")).toBe(0.5);
  });

  test("malformed lines are skipped without failing the load", () => {
    const dir = tmpDir();
    recordVerdict("ok.example", true, { dir });
    appendFileSync(
      join(dir, "trust.jsonl"),
      'not json\n[1,2]\n{"d":5,"p":1}\n{"d":"ok.example","p":2}\n',
    );
    recordVerdict("ok.example", true, { dir });
    recordVerdict("ok.example", true, { dir });
    const trust = loadTrust({ dir });
    expect(trust.get("ok.example")).toBe(1);
  });

  test("missing file loads as an empty map", () => {
    expect(loadTrust({ dir: tmpDir() }).size).toBe(0);
  });
});
