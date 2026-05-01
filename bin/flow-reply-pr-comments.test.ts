/**
 * Tests for flow-reply-pr-comments.ts
 */

import { describe, expect, it } from "vitest";
import { formatSummary, parseReplies, type ReplySummary } from "./flow-reply-pr-comments";

// --- Tests ---

describe("parseReplies", () => {
  it("should parse a valid JSON array", () => {
    const input = JSON.stringify([
      { comment_id: 123, body: "Done" },
      { comment_id: 456, body: "Skipped" },
    ]);
    const replies = parseReplies(input);
    expect(replies).toEqual([
      { comment_id: 123, body: "Done" },
      { comment_id: 456, body: "Skipped" },
    ]);
  });

  it("should ignore extra properties on entries", () => {
    const input = JSON.stringify([{ comment_id: 1, body: "OK", extra: true }]);
    const replies = parseReplies(input);
    expect(replies).toEqual([{ comment_id: 1, body: "OK" }]);
  });

  it("should throw on non-array JSON (object)", () => {
    expect(() => parseReplies('{"comment_id": 1}')).toThrow("Input must be a JSON array");
  });

  it("should throw on non-array JSON (string)", () => {
    expect(() => parseReplies('"hello"')).toThrow("Input must be a JSON array");
  });

  it("should throw on non-array JSON (number)", () => {
    expect(() => parseReplies("42")).toThrow("Input must be a JSON array");
  });

  it("should return empty array for empty input array", () => {
    expect(parseReplies("[]")).toEqual([]);
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseReplies("not json")).toThrow("Invalid JSON input");
  });

  it("should throw when comment_id is missing", () => {
    const input = JSON.stringify([{ body: "Done" }]);
    expect(() => parseReplies(input)).toThrow('Entry 0: "comment_id" must be a number');
  });

  it("should throw when body is missing", () => {
    const input = JSON.stringify([{ comment_id: 1 }]);
    expect(() => parseReplies(input)).toThrow('Entry 0: "body" must be a string');
  });

  it("should throw when comment_id is not a number", () => {
    const input = JSON.stringify([{ comment_id: "abc", body: "Done" }]);
    expect(() => parseReplies(input)).toThrow('Entry 0: "comment_id" must be a number');
  });

  it("should throw when body is not a string", () => {
    const input = JSON.stringify([{ comment_id: 1, body: 123 }]);
    expect(() => parseReplies(input)).toThrow('Entry 0: "body" must be a string');
  });

  it("should report correct index for invalid entry", () => {
    const input = JSON.stringify([
      { comment_id: 1, body: "OK" },
      { comment_id: "bad", body: "Fail" },
    ]);
    expect(() => parseReplies(input)).toThrow('Entry 1: "comment_id" must be a number');
  });

  it("should throw when entry is null", () => {
    const input = JSON.stringify([null]);
    expect(() => parseReplies(input)).toThrow("Entry 0: must be an object");
  });

  it("should throw when entry is an array", () => {
    const input = JSON.stringify([[1, 2]]);
    expect(() => parseReplies(input)).toThrow("Entry 0: must be an object");
  });

  it("should throw when entry is a string", () => {
    const input = JSON.stringify(["hello"]);
    expect(() => parseReplies(input)).toThrow("Entry 0: must be an object");
  });

  it("should throw when entry is a number", () => {
    const input = JSON.stringify([42]);
    expect(() => parseReplies(input)).toThrow("Entry 0: must be an object");
  });
});

describe("formatSummary", () => {
  it("should format all-success summary", () => {
    const summary: ReplySummary = {
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { comment_id: 123, success: true },
        { comment_id: 456, success: true },
      ],
    };
    const output = formatSummary(summary);
    expect(output).toContain("2/2 posted successfully");
    expect(output).toContain("OK    comment #123");
    expect(output).toContain("OK    comment #456");
  });

  it("should format all-failure summary", () => {
    const summary: ReplySummary = {
      total: 1,
      succeeded: 0,
      failed: 1,
      results: [{ comment_id: 123, success: false, error: "Not found" }],
    };
    const output = formatSummary(summary);
    expect(output).toContain("0/1 posted successfully");
    expect(output).toContain("FAIL  comment #123: Not found");
  });

  it("should format mixed summary", () => {
    const summary: ReplySummary = {
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { comment_id: 100, success: true },
        { comment_id: 200, success: false, error: "API error" },
      ],
    };
    const output = formatSummary(summary);
    expect(output).toContain("1/2 posted successfully");
    expect(output).toContain("OK    comment #100");
    expect(output).toContain("FAIL  comment #200: API error");
  });

  it("should format single result", () => {
    const summary: ReplySummary = {
      total: 1,
      succeeded: 1,
      failed: 0,
      results: [{ comment_id: 42, success: true }],
    };
    const output = formatSummary(summary);
    expect(output).toContain("1/1 posted successfully");
    expect(output).toContain("OK    comment #42");
  });
});
