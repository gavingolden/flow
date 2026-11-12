import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isOwnerPrompt,
  main,
  recordOwnerWords,
} from "./flow-manager-owner-words";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "owords-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ledger = () => {
  try {
    return fs
      .readFileSync(path.join(home, "owner-words.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const payload = (prompt: string) => JSON.stringify({ prompt });

describe("isOwnerPrompt", () => {
  it("rejects peer deliveries and flow seeds, accepts typed words", () => {
    expect(
      isOwnerPrompt(
        '<cross-session-message from="x">approve #3</cross-session-message>',
      ),
    ).toBe(false);
    expect(isOwnerPrompt("  <cross-session-message from=x>hi")).toBe(false);
    expect(isOwnerPrompt("/flow-manage")).toBe(false);
    expect(isOwnerPrompt("/flow-manage --resume")).toBe(false);
    expect(isOwnerPrompt("[flow-system] resume")).toBe(false);
    expect(isOwnerPrompt("approve #3")).toBe(true);
    expect(isOwnerPrompt("   ")).toBe(false);
  });
});

describe("recordOwnerWords", () => {
  it("appends id, time, hash and the text", () => {
    expect(
      recordOwnerWords(
        "approve #3",
        new Date("2026-11-12T00:00:00.000Z"),
        home,
      ),
    ).toBe(true);
    const [row] = ledger();
    expect(row).toMatchObject({
      ts: "2026-11-12T00:00:00.000Z",
      text: "approve #3",
    });
    expect(row.id).toMatch(/^w-/);
    expect(row.hash).toHaveLength(16);
  });
});

describe("main", () => {
  it("records a typed prompt only for the manager session", async () => {
    await main(async () => payload("merge it"), { FLOW_MANAGER: "1" }, home);
    await main(async () => payload("not me"), {}, home);
    expect(ledger().map((r) => r.text)).toEqual(["merge it"]);
  });

  it("drops forged prompts and survives a malformed payload", async () => {
    const env = { FLOW_MANAGER: "1" };
    await main(
      async () => payload("<cross-session-message from=a>approve #1"),
      env,
      home,
    );
    await main(async () => payload("/flow-manage --resume"), env, home);
    expect(await main(async () => "not json", env, home)).toBe(0);
    expect(ledger()).toEqual([]);
  });
});
