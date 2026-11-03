import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooldownRemainingMs, recordChallenge } from "../src/cooldown";

const tempDir = () => mkdtempSync(join(tmpdir(), "qany-cooldown-"));

describe("engine cooldowns", () => {
  test("records a 10 minute cooldown and reports the remainder", () => {
    const dir = tempDir();
    const now = 1_000_000;
    expect(recordChallenge("duckduckgo", now, dir)).toBe(600_000);
    expect(cooldownRemainingMs("duckduckgo", now + 60_000, dir)).toBe(540_000);
    expect(cooldownRemainingMs("duckduckgo", now + 600_001, dir)).toBe(0);
  });

  test("escalates when challenged again within the reset window", () => {
    const dir = tempDir();
    const now = 1_000_000;
    recordChallenge("brave", now, dir);
    expect(recordChallenge("brave", now + 600_001, dir)).toBe(1_800_000);
    // A challenge after a long quiet period starts over at the base duration.
    expect(recordChallenge("brave", now + 600_001 + 1_800_001, dir)).toBe(
      600_000,
    );
  });

  test("treats a corrupt state file as no cooldowns", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "cooldowns.json"), "not json");
    expect(cooldownRemainingMs("duckduckgo", 1_000_000, dir)).toBe(0);
  });
});
