import { describe, expect, it } from "vitest";
import {
  looksSchemaRejected,
  looksTimedOut,
  looksUnauthenticated,
} from "./agy-output";

describe("looksUnauthenticated", () => {
  it.each([
    "Error: not authenticated",
    "Please log in to continue",
    "unauthenticated request",
    "authentication required",
    "Error: not logged in",
    "please sign in to Google",
    "authentication failed",
    "session expired, please reauthenticate",
  ])("flags auth-error text: %s", (text) => {
    expect(looksUnauthenticated(text)).toBe(true);
  });

  it("does not flag a generic runtime error", () => {
    expect(looksUnauthenticated("model run timed out after 5m")).toBe(false);
  });
});

describe("looksTimedOut", () => {
  it("flags agy's verified --print-timeout stderr signature", () => {
    expect(looksTimedOut("Error: timeout waiting for response")).toBe(true);
  });

  it("flags related timeout phrasing", () => {
    expect(looksTimedOut("deadline exceeded")).toBe(true);
    expect(looksTimedOut("context deadline exceeded")).toBe(true);
  });

  it("does not flag an auth-flavored error", () => {
    expect(looksTimedOut("Please log in to continue")).toBe(false);
  });

  it("does not flag a generic error", () => {
    expect(looksTimedOut("something went wrong")).toBe(false);
  });

  it("flags the log-file-only 'Print mode: timed out after N polls' literal (never reaches stdout/stderr today)", () => {
    expect(
      looksTimedOut("Print mode: timed out after 1491 polls (printed=17)"),
    ).toBe(true);
  });
});

describe("looksSchemaRejected", () => {
  it.each([
    'Error: invalid --json-schema: failed to read schema file "/x/schema.json": open /x/schema.json: no such file or directory',
    "Error: invalid --json-schema: schema is not valid JSON: unexpected end of JSON input",
  ])("matches %s", (msg) => {
    expect(looksSchemaRejected(msg)).toBe(true);
  });

  it.each([
    "Error: something went wrong",
    "Error: timeout waiting for response",
  ])("does not match %s", (msg) => {
    expect(looksSchemaRejected(msg)).toBe(false);
  });
});
