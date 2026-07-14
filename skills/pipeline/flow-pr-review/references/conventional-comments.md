# Conventional Comments Reference

A labeling framework for code review feedback. Every comment gets a label that communicates
its intent, and a decoration that signals whether it blocks approval.

The goal is clarity: a developer scanning review comments should instantly know what kind of
feedback each one is (a bug? a suggestion? just a thought?) and whether they need to act on
it before merging.

## Labels

| Label          | When to use                                                            | Blocks merge?         |
| -------------- | ---------------------------------------------------------------------- | --------------------- |
| **praise**     | Something done well — good naming, clean abstraction, elegant solution | Never                 |
| **nitpick**    | Minor stylistic preference; take it or leave it                        | Never                 |
| **suggestion** | An improvement idea that isn't a bug                                   | Depends on decoration |
| **issue**      | Something is wrong and needs fixing                                    | Usually yes           |
| **todo**       | A specific change required before merge                                | Always                |
| **question**   | Genuine uncertainty — you need the author's input to judge             | Never                 |

### Label guidance

- **praise**: Aim for at least one per review. Reinforces good patterns and makes the review
  feel collaborative rather than adversarial. Be specific — "praise: Clean separation of the
  fetch logic from the rendering" is better than "praise: Looks good."

- **nitpick**: Reserve for true preferences with no correctness impact. If you catch yourself
  writing a nitpick that you'd actually want fixed, it's probably a `suggestion` instead.

- **suggestion**: The workhorse label. Use when there's a better way to do something but the
  current code isn't broken. Always include a concrete alternative.

- **issue**: Something that will cause incorrect behavior, a crash, data loss, or a security
  vulnerability. Pair with a suggestion or code snippet showing the fix.

- **todo**: Like `issue` but for smaller, unambiguous changes (missing null check, forgotten
  cleanup). The distinction: `issue` benefits from discussion, `todo` is clearly needed.

- **question**: Use when you genuinely aren't sure whether something is a problem. Asking a
  question is better than raising a false-positive issue.

## Decorations

| Decoration       | Meaning                           | When to use                                                               |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------- |
| **blocking**     | Must be resolved before approval  | Bugs, security issues, correctness problems                               |
| **non-blocking** | Author's discretion               | Style preferences, minor improvements, ideas                              |
| **if-minor**     | Blocking only if the fix is small | "If this is a quick rename, do it; if it requires restructuring, skip it" |

## Format

```
<label> (<decoration>): <subject>

<body — explanation, context, and suggestion>
```

### Examples

```
praise: Clean extraction of retry logic into a reusable helper

This makes the error handling much easier to follow and test independently.
```

```
issue (blocking): Race condition in concurrent cache updates

Two simultaneous `updateCache()` calls can interleave their read-modify-write
cycles, causing one update to silently overwrite the other.

Suggestion: Use a mutex or queue writes through a single async pipeline:
  const cache = new AsyncLock();
  await cache.acquire(() => { /* read-modify-write */ });
```

```
suggestion (non-blocking): Consider using Map for O(1) lookups

The current array `.find()` on line 84 is O(n) per lookup. With ~200 items
this won't be noticeable, but a Map would be cleaner and future-proof.
```

```
nitpick (non-blocking): Slightly clearer variable name

`data` is generic — `userProfiles` would make the destructuring on line 91
self-documenting.
```

```
question (non-blocking): Is this intentionally synchronous?

The `loadConfig()` call on line 12 blocks the main thread. If the config
file is small this is fine, but if it could grow I'd suggest `await`ing
an async version.
```

```
todo (blocking): Add null check for user.profile

`user.profile.name` on line 43 will throw if `profile` is null. This path
is reachable when a new user hasn't completed onboarding.

Fix:
  const name = user.profile?.name ?? "Anonymous";
```

## Rules for This Skill

1. Every finding MUST have a label
2. Every finding except `praise` MUST have a decoration
3. `issue` and `todo` findings MUST include a suggestion or code snippet
4. At least one `praise` per review
5. Only surface findings with confidence >= 80 (praise is exempt)
6. Confidence scores appear in the report but NOT in PR comments
