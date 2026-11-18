import { describe, expect, it } from "vitest";
import { STDIN_READERS, stdinHang } from "./stdin-hang";

const HANG = `grep -rln '"<masked>"\\|<masked>' --include=*.js . 2>/dev/null; grep -n "maskCapturedNetworkRequestFn" $(grep -rl 'url_changed' --include=*.js .) | head -5`;

describe("stdinHang — denied", () => {
  it.each([
    ["the verbatim 13-hour hang command", HANG],
    [
      "a wc < file followed by a substitution-fed grep",
      "wc -l < a.txt; grep -n x $(grep -rl y .) | head -5",
    ],
    ["cat with only a substitution operand", "wc -l < in.txt; cat $(ls *.md)"],
    ["head -n with a value option", "wc -l < in; head -n 5 $(git ls-files)"],
    ["a backtick operand", "wc -l < in; grep -n x `git ls-files`"],
    ["a quoted substitution operand", 'wc -l < in; cat "$(readlink -f f)"'],
    ["a reader after && ", "wc -l < in && grep x $(find .)"],
    [
      "a reader in a subshell group without a group redirect",
      "( grep x $(find .) ); wc -l < a",
    ],
    ["-e supplying the pattern", "wc -l < in; grep -e x $(find .)"],
  ])("should flag %s", (_n, cmd) => {
    expect(stdinHang(cmd)).toBe(true);
  });
});

describe("stdinHang — allowed", () => {
  it.each([
    [
      "/dev/null appended",
      "wc -l < a.txt; grep -n x $(grep -rl y .) /dev/null | head -5",
    ],
    [
      "</dev/null on the grep",
      "wc -l < a.txt; grep -n x $(grep -rl y .) </dev/null | head -5",
    ],
    ["no < anywhere", "grep -n x $(git ls-files) | head"],
    ["a reader fed by a pipe", "echo hi | grep x $(find .) < in"],
    ["cat of a quoted substitution with no <", 'cat "$(readlink -f f)"'],
    [
      "a heredoc body that holds the shape",
      "python3 - <<'EOF'\ngrep x $(find .)\nEOF",
    ],
    ["awk with a < inside its program", "awk 'BEGIN { print (1 < 2) }'"],
    ["grep -rn of an angle-bracket pattern", "grep -rn '<Button>' src"],
    ["a group with its own redirect", "{ head -1 $(find .); } < f"],
    ["a subshell with its own redirect", "( head -1 $(find .) ) < f"],
    ["a mixed operand list", "cat a.txt $(find .) < in"],
    ["no operands", "cat < in; head -5"],
    ["a non-reader", "ls $(find .) < in"],
    ["heredoc plus real redirect on the reader", "cat <<EOF\nx\nEOF"],
  ])("should not flag %s", (_n, cmd) => {
    expect(stdinHang(cmd)).toBe(false);
  });
});

describe("STDIN_READERS", () => {
  it("should carry the census reader set", () => {
    expect([...STDIN_READERS].sort()).toEqual(
      [
        "awk",
        "cat",
        "cut",
        "egrep",
        "fgrep",
        "grep",
        "head",
        "rg",
        "sed",
        "sort",
        "tail",
        "uniq",
        "wc",
      ].sort(),
    );
  });
});
