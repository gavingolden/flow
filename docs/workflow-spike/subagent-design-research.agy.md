# AGY raw output (2026-09-07) — see subagent-design-research.md for caveats

## Prompt

```
Research question (web-grounded, cite sources with URLs, be adversarial toward hype):

Does decomposing a long-running LLM coding-agent pipeline into many short-lived sub-agents (orchestrator + workers with isolated contexts) improve or degrade outcomes versus a single long-context agent? Specifically for software-engineering agent pipelines (implement → verify → CI → review → merge), report evidence on:

1. Task success / correctness: studies or benchmarks comparing single-agent vs multi-agent / orchestrator-worker designs (e.g. Anthropic's multi-agent research system post, Cognition's "Don't build multi-agents", Google/DeepMind or academic papers on multi-agent failure modes such as "Why do multi-agent LLM systems fail?" (MAST taxonomy), SWE-bench agent comparisons, METR or similar).
2. Cost: token overhead of fresh-context workers (system prompt / tool schema re-establishment, prompt-cache miss) vs one long context; any measured multipliers.
3. Context loss / coordination failures: evidence that workers lacking the orchestrator's history make worse decisions, and what mitigations are documented (shared scratchpads/artifacts on disk, structured handoffs, typed schemas, single-writer rules).
4. Observability: how production agent systems surface worker failures to the orchestrator; whether "silent wrong result" is a documented dominant failure class.
5. When multi-agent DOES win: parallelizable read-heavy work (research, review lenses), context-ceiling avoidance, isolation of untrusted or noisy output.

Output: a concise structured report with headings matching 1-5, each with 2-5 bullets, each bullet citing a URL. End with a one-paragraph verdict: for a pipeline where the orchestrator previously did everything inline and hit context limits on large tasks, what design does the evidence support (single agent with context management, thin orchestrator + few large workers, or many small workers)? Distinguish "parallel read-only fan-out" from "sequential write handoff" explicitly.
```

## Output

## 1. Task success / correctness

- **Compound failure modes of multi-agent networks**: Anthropic's research on agent architectures in ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents) demonstrates that complex multi-agent frameworks often reduce overall task reliability for routine software engineering tasks due to cascading errors, increased coordination overhead, and unpredictable state transitions compared to simple, single-agent workflows.
- **Context fragmentation in code generation**: Cognition AI's article ["Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) highlights that delegating sequential software tasks across multiple autonomous sub-agents fragments the mental model of the codebase, leading to conflicting implicit choices and lower task completion rates than a single long-context agent maintaining continuous state.
- **Empirical failure taxonomy (MAST)**: The UC Berkeley / NeurIPS 2025 paper ["Why Do Multi-Agent LLM Systems Fail?"](https://arxiv.org/abs/2503.13657) analyzed over 1,600 execution traces across multi-agent frameworks (AutoGen, MetaGPT, ChatDev) and established the Multi-Agent System Failure Taxonomy (MAST), revealing 14 distinct failure modes across system design, inter-agent misalignment, and verification breakdowns.
- **Single-pipeline superiority on benchmarks**: The research paper ["Agentless: Demystifying LLM-based Software Engineering Agents"](https://arxiv.org/abs/2407.01489) showed that a simple, agentless procedural workflow (hierarchical localization $\rightarrow$ patch generation $\rightarrow$ patch validation) achieved a 27.3% resolve rate on SWE-bench Lite, matching or outperforming complex multi-agent systems while completely eliminating multi-agent loops and agent negotiation failures.
- **Task horizon degradation**: Evaluation studies from [METR (Model Evaluation & Threat Research)](https://metr.org/time-horizons/) show that as software task length and step count increase, unstructured multi-agent handoffs degrade correctness due to state divergence unless strict, human-calibrated verification gates are enforced at each step.

---

## 2. Cost

- **Prompt cache invalidation penalty**: As detailed in Anthropic's ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents), short-lived workers spawned with fresh context windows must re-instantiate base system prompts, tool definitions, and repository metadata, forfeiting 50%–90% input-token discount gains achieved by long-context single agents through prompt caching.
- **Multi-agent token multipliers on SWE-bench**: Empirical cost measurements in ["Agentless: Demystifying LLM-based Software Engineering Agents"](https://arxiv.org/abs/2407.01489) demonstrated that multi-agent frameworks (such as ChatDev or AutoGen) incur token costs between $2.00 and $10.00+ per software issue due to repetitive inter-agent dialogue, whereas single-pipeline architectures averaged $0.34 per issue.
- **The "Parallelization Trap" tax**: In Anthropic's engineering breakdown ["How we built our multi-agent research system"](https://www.anthropic.com/engineering/built-multi-agent-research-system), researchers note that launching multiple concurrent sub-agents without pre-warmed cache prefixes leads to simultaneous full-price cache writes, creating an $O(N)$ token cost multiplier per worker turn.

---

## 3. Context loss / coordination failures

- **Inter-agent context degradation**: The MAST taxonomy paper ["Why Do Multi-Agent LLM Systems Fail?"](https://arxiv.org/abs/2503.13657) documents that sub-agents operating with isolated contexts frequently lack the orchestrator's implicit decision history (e.g., previously rejected refactoring attempts or architectural constraints), leading to repeated mistakes and inter-agent misalignment.
- **Shared state via disk scratchpads**: Cognition AI's breakdown in ["Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) emphasizes that production systems avoid context loss by maintaining shared, file-backed state on disk (such as `PLAN.md` or git commits) rather than relying on LLM-to-LLM conversational memory handoffs.
- **Structured handoffs over freeform messaging**: Anthropic's guide ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents) shows that replacing natural language messages with structured JSON schemas, typed models, or standardized protocol layers (like the Model Context Protocol) prevents prompt drift and ambiguous task delegation between agents.
- **Single-writer execution rules**: Anthropic's deep-dive ["How we built our multi-agent research system"](https://www.anthropic.com/engineering/built-multi-agent-research-system) details that multi-agent systems must enforce single-writer constraints—where only the primary agent or one sub-agent at a time has file mutation rights—to eliminate race conditions and conflicting code modifications.

---

## 4. Observability

- **The "Silent Wrong Result" failure class**: Systematic trace analysis in ["Why Do Multi-Agent LLM Systems Fail?"](https://arxiv.org/abs/2503.13657) identifies "silent wrong results" as a dominant failure class in multi-agent systems, where sub-agents report successful task completion to the orchestrator despite outputting broken code or failing underlying tests.
- **Evaluator-Optimizer verification loops**: Anthropic's engineering patterns in ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents) establish that production pipelines cannot rely on worker self-reporting; they require independent evaluator agents or non-LLM deterministic checks (e.g., unit test exit codes, linters) to confirm step completion.
- **Standardized trajectory tracing**: Infrastructure standards highlighted on the [METR Time Horizons methodology hub](https://metr.org/time-horizons/) emphasize logging full step-by-step agent trajectories (tool calls, state changes, sub-agent exit statuses) using structured frameworks like Inspect AI to surface hidden worker failures for post-mortem debugging.

---

## 5. When multi-agent DOES win

- **Parallelizable read-heavy research fan-out**: Anthropic's engineering post ["How we built our multi-agent research system"](https://www.anthropic.com/engineering/built-multi-agent-research-system) demonstrates that multi-agent architectures significantly outperform single agents on broad research tasks by spawning parallel, read-only workers to explore distinct search paths concurrently and synthesize findings back to the main agent.
- **Context-ceiling avoidance via noise isolation**: Anthropic's overview in ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents) notes that delegating verbose search tasks or large log file parsing to ephemeral sub-agents isolates raw output, preventing the orchestrator's context window from degrading due to prompt clutter.
- **Specialized non-mutating review lenses**: Architectural patterns from Cognition AI in ["Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) support spawning single-purpose, read-only sub-agents (e.g., security auditors, style checkers, performance analyzers) to evaluate proposed code changes concurrently without muddying the main builder agent's focus.
- **Sandbox and safety isolation**: The Anthropic codebase pattern guide in the [Anthropic Agent Cookbook](https://github.com/anthropics/anthropic-cookbook) highlights using isolated sub-agent environments for executing untrusted web searches or shell code, protecting the primary orchestrator's execution loop from untrusted inputs or context corruption.

---

## Verdict

For a software engineering pipeline that previously ran inline and hit context limits on large tasks, the evidence overwhelmingly supports a **thin orchestrator combined with a single primary worker using active context management (compaction/scratchpads)** rather than a fine-grained swarm of small writing workers. Empirical benchmarks demonstrate a fundamental distinction: **parallel read-only fan-out** (e.g., searching documentation, gathering repo context, or running concurrent review lenses) is highly effective when offloaded to short-lived sub-agents because read operations do not mutate shared state and raw context can be summarized before returning to the main agent. In contrast, **sequential write handoffs** across multiple sub-agents (e.g., delegating implementation $\rightarrow$ verification $\rightarrow$ fixing across distinct editing workers) consistently degrade correctness due to context loss, cache-invalidation cost penalties, and silent failure propagation. Consequently, the evidence favors restricting sub-agents exclusively to parallel read-only research and verification lenses, while keeping code modifications strictly single-agent (or single-writer) managed via disk-backed scratchpads and structured context pruning.
