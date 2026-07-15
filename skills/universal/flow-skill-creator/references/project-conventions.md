# Project Conventions for Skills

Skills live in `.claude/skills/<skill-name>/`. Project-wide rules live in `AGENTS.md` —
skills must not restate them.

## Progressive Disclosure (3-Level System)

| Level                                                      | What                    | Loaded When             |
| ---------------------------------------------------------- | ----------------------- | ----------------------- |
| 1. YAML frontmatter                                        | `name` + `description`  | Always (system prompt)  |
| 2. SKILL.md body                                           | Full instructions       | When skill is activated |
| 3. Linked files (`references/`, `examples/`, `templates/`) | Detailed docs, examples | On-demand by the agent  |

**Implication:** Keep SKILL.md focused on core instructions. Move detailed documentation,
extended examples, and external reference material to `references/` or `examples/`.

## Standard Section Headers

Use these headers in skill SKILL.md files (omit any that don't apply):

| Header              | Purpose                                  | Required?   |
| ------------------- | ---------------------------------------- | ----------- |
| `# Goal`            | 1-2 sentence objective                   | Yes         |
| `# When to Use`     | Specific activation scenarios            | Yes         |
| `# When NOT to Use` | Boundaries and deferrals to other skills | Yes         |
| `# Context`         | Project paths, conventions, architecture | Yes         |
| `# Instructions`    | Numbered, deterministic steps            | Yes         |
| `# Verification`    | How to confirm the task is complete      | Yes         |
| `# Constraints`     | Strict negative rules (`NEVER do X`)     | Recommended |

## Review Checklist

Before saving a skill, verify every item:

- [ ] `description` includes WHAT + WHEN + trigger phrases
- [ ] `description` is under 1024 characters with no XML tags
- [ ] `name` is kebab-case and matches the folder name
- [ ] No `README.md` inside the skill folder
- [ ] Instructions are deterministic — no ambiguous steps
- [ ] `When NOT to Use` has at least one entry with a deferral target
- [ ] Verification steps are concrete (commands to run, output to check)
- [ ] No overlap with `AGENTS.md` — project-wide rules reference it, not restate it
- [ ] SKILL.md body is under 500 lines
- [ ] At least one example or template is included for non-trivial skills
- [ ] Error handling or troubleshooting is covered for skills that invoke tools

## Anti-Patterns

### Vague Descriptions

```yaml
# Bad: No triggers, no specificity
description: Helps with data processing.

# Good: Specific scope, clear triggers
description: >-
  Process CSV financial data for quarterly reports. Use when user says
  "generate Q report", "process CSV data", or uploads .csv files.
```

### Monolithic Skills

If a skill tries to cover multiple unrelated workflows, split it. Each skill should have a single
responsibility. Example: don't combine "database migrations" and "Svelte component creation" in one
skill — they have different triggers, contexts, and verification steps.

### Instruction Verbosity

SKILL.md over ~200 lines of instructions signals that reference material should be extracted to
`references/`. The agent loads SKILL.md body into context — keep it tight.

## Constraints

- NEVER restate rules that already exist in `AGENTS.md` — reference it instead.
- NEVER include `README.md` inside a skill folder — all docs go in `SKILL.md` or `references/`.
- NEVER use XML angle brackets in frontmatter (security restriction).
- NEVER reference agent-specific or IDE-specific tool names (e.g., `view_file`, `Cwd`) in
  instructions — use generic verbs ("read", "open", "run") so skills work across agent runtimes.
- Skill body must not exceed 500 lines.
- Keep skills single-responsibility.

## Troubleshooting Patterns

### Skill Doesn't Trigger (Under-triggering)

- Description too generic or missing trigger phrases
- **Fix:** Add specific keywords, paraphrased requests, and file types
- **Debug:** Ask the agent "When would you use the [skill-name] skill?" — adjust based on response

### Skill Triggers Too Often (Over-triggering)

- Description too broad
- **Fix:** Add negative triggers ("Do NOT use for..."), narrow scope, clarify boundaries

### Instructions Not Followed

1. **Too verbose** — Keep instructions concise; move reference material to `references/`
2. **Critical rules buried** — Move them to the top; use `**CRITICAL:**` or `## Important` headers
3. **Ambiguous language** — Replace "validate things properly" with exact checks and expected outputs
4. **For deterministic validation** — Bundle a script instead of relying on language instructions

## Workflow Patterns

Five common patterns for structuring skill instructions:

| Pattern                          | Use When                                 | Key Technique                                       |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| **Sequential orchestration**     | Multi-step process in specific order     | Explicit step ordering + validation gates           |
| **Multi-source coordination**    | Workflow spans multiple tools/APIs       | Phase separation + data passing between phases      |
| **Iterative refinement**         | Output quality improves with iteration   | Quality criteria + refinement loop + stop condition |
| **Context-aware selection**      | Same outcome, different tools by context | Decision tree + fallback options                    |
| **Domain-specific intelligence** | Skill adds specialized knowledge         | Embedded domain rules + compliance checks           |
