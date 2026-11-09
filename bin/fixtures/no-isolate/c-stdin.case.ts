import * as fs from "node:fs";
import { expect, it } from "vitest";

it("reads end-of-input from stdin instead of blocking", () => {
  expect(fs.readSync(0, Buffer.alloc(16))).toBe(0);
});
