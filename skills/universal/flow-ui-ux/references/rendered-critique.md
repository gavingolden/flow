# Rendered-gallery critique

The rubric for judging a page that has already been rendered and captured: a set of per-section screenshots plus each route's accessibility snapshot, not live code. It extends `critique-protocol.md` (which walks the six dimensions against code or a single capture) to a multi-section gallery, and it is stack-agnostic — name the principle and its source file, never a framework mechanic. Judgment lives here; capturing the shots and measuring the page are other jobs.

## Inputs

You are handed, in this order of authority:

1. **Each route's accessibility snapshot text** — primary for hierarchy, roles, names and reading order (SKILL.md §5). A finding about structure or order is grounded here.
2. **A gallery of viewport-sized per-section shots** at phone 390, desktop 1280 and, when present, desktop-dark, with a start shot and an end shot for any section taller than the viewport. Supplementary: use them for spacing rhythm, alignment, hierarchy, contrast and density.
3. **The plan's `## Layout Intent`**, including its design-intent bullets (who, feel, the default this rejects, the polish bar, the judged scope). The polish bar names the qualities the finished page must show; judge against it.
4. **The probe's smells**, as hints, not verdicts. A smell points at where to look; it is never a finding on its own, and a clean probe never excuses a visible problem.

A screenshot is never the sole basis for a finding. Ground each observation in what a second viewer would also see in the snapshot or the same shot.

## Severity

- **`defect`** — a reader is blocked or misled: overlapping or clipped text, illegible contrast, leaked markup, a control that cannot be reached, a chart scale that hides the variation the section is about. A zero baseline is correct for bar and area charts and is never a finding by itself.
- **`major`** — a visible violation of a design-intent polish bar or of a named rule in `visual-design.md`, `layout.md` or `accessibility.md`: cramped multi-column content at phone width, flat hierarchy, an undifferentiated wall of content, duplicate controls.
- **`minor`** — taste. Record it; it is never a reason to change the page.

## Finding shape

Each finding carries:

- the **route**, the **section** and the **viewport** it was seen at;
- the **`shot`** path the observation is grounded on;
- the **observation** — what is wrong, stated so a second viewer would confirm it;
- the **rule** — the reference file and the principle it comes from;
- a **fix direction** — what outcome would resolve it. Never "remove the content", and never a framework mechanic (no class names, no component API).

## Post-round critique

After a fix round the new gallery is judged as if fresh: with no knowledge of earlier findings or of what changed. The same severity bar applies. The loop, not the critic, compares rounds — a critic that knows what was fixed grades its own homework.

## Never

- Judge copy accuracy or data truth: whether a number or sentence is correct is not a design finding.
- Tick, assess or answer a `SUBJECTIVE:` item. Those belong to a human.
- Name a stack class or component API.
