import { describe, expect, it } from "vitest";

import { readUiCritiqueEnabled } from "./ui-critique-config";

const reading = (raw: string | null) => readUiCritiqueEnabled(() => raw);

describe("readUiCritiqueEnabled", () => {
  it.each([
    ["an absent file", null],
    ["malformed JSON", "{not json"],
    ["an empty object", "{}"],
    ["ui: null", '{"ui":null}'],
    ["a missing key", '{"ui":{}}'],
    ["an explicit true", '{"ui":{"critique":true}}'],
    ["a wrong-typed value", '{"ui":{"critique":"false"}}'],
    ["a JSON null document", "null"],
  ])("reads %s as enabled", (_name, raw) => {
    expect(reading(raw)).toBe(true);
  });

  it("only a strict false disables", () => {
    expect(reading('{"ui":{"critique":false}}')).toBe(false);
  });

  it("reads the config file through the injected reader", () => {
    const seen: string[] = [];
    readUiCritiqueEnabled((p) => {
      seen.push(p);
      return null;
    });
    expect(seen).toEqual(["config"]);
  });
});
