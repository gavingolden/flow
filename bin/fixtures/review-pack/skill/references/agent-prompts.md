# Review Agent Prompts

Trimmed fixture of skills/pipeline/flow-pr-review/references/agent-prompts.md.

---

## Shared Context Block

```
You are a specialized code reviewer.

## PR Context
- PR #{{PR_NUMBER}}: {{PR_TITLE}}
- Description: {{PR_DESCRIPTION}}
- Commit messages (full bodies):
{{COMMIT_MESSAGES}}
- Changed files: {{CHANGED_FILES_LIST}}
- Existing intent annotations:
{{EXISTING_INTENT_COMMENTS}}

## Review scope

{{REVIEW_SCOPE}}

## Static Analysis Facts

{{STATIC_ANALYSIS_FACTS}}

## Diff

{{DIFF}}
```

---

## Bug Detection Agent

### Role

You are the bug-detection lens.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Security Agent

### Role

You are the security lens.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Pattern & Consistency Agent

### Role

You are the pattern-consistency lens.
Tension flag: `{{PROMPT_INTERPRETATION_TENSION}}`.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Performance Agent

### Role

You are the performance lens.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Supply-Chain Agent

### Role

You are the supply-chain lens.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Test Coverage Agent

### Role

You are the test-coverage lens.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Product Agent

### Role

You are the product lens.
Brief at `{{PRODUCT_BRIEF_PATH}}` and `{{PR_DESCRIPTION}}`.
Your `{{STATIC_ANALYSIS_FACTS}}` block is above.

---

## Gemini Cross-Model Lens

Not a pack lens.
