import { describe, expect, it } from "vitest";
import { applyManagedBlock, hasManagedBlock, removeManagedBlock } from "./rc-block";

const TAG = "completions";
const BODY = [
  '[ -f "$HOME/.flow/completions/flow.zsh" ] && source "$HOME/.flow/completions/flow.zsh"',
];

describe("applyManagedBlock", () => {
  it("appends the block to an empty file", () => {
    const result = applyManagedBlock("", TAG, BODY);
    expect(result).toBe(
      `# managed by flow completions
${BODY[0]}
# end flow completions
`,
    );
  });

  it("appends the block to a file with existing trailing content, separated by a blank line", () => {
    const input = "alias ll='ls -la'\nexport EDITOR=vim\n";
    const result = applyManagedBlock(input, TAG, BODY);
    expect(result).toBe(
      `alias ll='ls -la'
export EDITOR=vim

# managed by flow completions
${BODY[0]}
# end flow completions
`,
    );
  });

  it("replaces an existing block in place rather than duplicating it", () => {
    const input = `alias ll='ls -la'

# managed by flow completions
old line
# end flow completions
`;
    const result = applyManagedBlock(input, TAG, BODY);
    expect(result).toBe(
      `alias ll='ls -la'

# managed by flow completions
${BODY[0]}
# end flow completions
`,
    );
    // Only one block.
    expect(result.match(/# managed by flow completions/g)?.length).toBe(1);
  });

  it("is idempotent: re-applying the same body yields a byte-identical result", () => {
    const input = "alias ll='ls -la'\n";
    const once = applyManagedBlock(input, TAG, BODY);
    const twice = applyManagedBlock(once, TAG, BODY);
    expect(twice).toBe(once);
  });

  it("removes an existing block when called with an empty body", () => {
    const input = `alias ll='ls -la'

# managed by flow completions
${BODY[0]}
# end flow completions
`;
    const result = applyManagedBlock(input, TAG, []);
    expect(result).toBe("alias ll='ls -la'\n");
  });

  it("does not write a block when input is empty and body is empty", () => {
    expect(applyManagedBlock("", TAG, [])).toBe("");
  });

  it("preserves the leading prefix exactly when replacing a block in the middle of a file", () => {
    const input = `# my settings
alias g=git

# managed by flow completions
old
# end flow completions

# trailing comment kept by user
`;
    const result = applyManagedBlock(input, TAG, BODY);
    expect(result).toBe(
      `# my settings
alias g=git

# managed by flow completions
${BODY[0]}
# end flow completions

# trailing comment kept by user
`,
    );
  });
});

describe("removeManagedBlock", () => {
  it("returns the input unchanged when no block is present", () => {
    const input = "alias ll='ls -la'\n";
    expect(removeManagedBlock(input, TAG)).toBe(input);
  });

  it("removes the block and the blank line that separates it from prior content", () => {
    const input = `alias ll='ls -la'

# managed by flow completions
${BODY[0]}
# end flow completions
`;
    expect(removeManagedBlock(input, TAG)).toBe("alias ll='ls -la'\n");
  });

  it("leaves rc file byte-identical to pre-install state when removing the only managed content", () => {
    const original = "alias ll='ls -la'\nexport EDITOR=vim\n";
    const installed = applyManagedBlock(original, TAG, BODY);
    expect(installed).not.toBe(original);
    const removed = removeManagedBlock(installed, TAG);
    expect(removed).toBe(original);
  });

  it("only removes the named tag — other flow blocks are untouched", () => {
    const input = `# managed by flow completions
${BODY[0]}
# end flow completions

# managed by flow other-tag
echo other
# end flow other-tag
`;
    const result = removeManagedBlock(input, TAG);
    expect(result).toContain("# managed by flow other-tag");
    expect(result).not.toContain("# managed by flow completions");
  });
});

describe("hasManagedBlock", () => {
  it("returns false when neither marker is present", () => {
    expect(hasManagedBlock("alias ll='ls -la'\n", TAG)).toBe(false);
  });

  it("returns true when both markers are present and well-ordered", () => {
    const input = applyManagedBlock("", TAG, BODY);
    expect(hasManagedBlock(input, TAG)).toBe(true);
  });

  it("returns false when only the begin marker is present (corrupted block)", () => {
    const input = "# managed by flow completions\nstuff\n";
    expect(hasManagedBlock(input, TAG)).toBe(false);
  });

  it("does not match a different tag", () => {
    const input = applyManagedBlock("", TAG, BODY);
    expect(hasManagedBlock(input, "other-tag")).toBe(false);
  });
});
