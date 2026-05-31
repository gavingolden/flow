# Interaction and UX

Portable interaction judgment, structured on Jakob Nielsen's 10 usability heuristics (NNG), applied as stack-neutral principles. Each heuristic is named inline so its grounding is traceable; canonical URLs live in `sources.md`. The framework that renders a state (a spinner, a toast, a disabled control) is the stack skill's job — what follows is *which* states must exist and *why*.

## The ten heuristics, applied

**1. Visibility of system status** (Nielsen heuristic). The interface keeps the user informed about what is happening, through timely feedback. Every action gets a visible response; long operations show progress, not a frozen surface; the current location, selection, and mode are always legible. Loading, success, and in-progress states are part of the design, not afterthoughts.

**2. Match between the system and the real world** (Nielsen heuristic). Speak the user's language — words, phrases, and concepts they recognize — rather than internal jargon or system codes. Order information the way the user expects it, following real-world conventions.

**3. User control and freedom** (Nielsen heuristic). Users pick functions by mistake; give them a clearly marked exit. Support undo and redo; let people cancel, back out, and dismiss without being trapped in a flow. Destructive actions are reversible or confirmed.

**4. Consistency and standards** (Nielsen heuristic). The same thing is called the same name and behaves the same way everywhere. Follow platform and industry conventions so users don't have to wonder whether different words or actions mean the same thing.

**5. Error prevention** (Nielsen heuristic). Better than a good error message is a design that prevents the error. Remove error-prone conditions, constrain inputs to valid values, and confirm before committing consequential or irreversible actions.

**6. Recognition rather than recall** (Nielsen heuristic). Minimize what the user must hold in memory — make options, actions, and previously entered values visible or easily retrievable rather than forcing the user to remember them from one part of the interface to another.

**7. Flexibility and efficiency of use** (Nielsen heuristic). Serve both novice and expert. Accelerators (shortcuts, defaults, recently-used) that are invisible to beginners speed up experts. Progressive disclosure is the portable mechanism here: show the common path by default and reveal advanced options on demand, so the surface stays simple without losing power.

**8. Aesthetic and minimalist design** (Nielsen heuristic). Content competes for attention; every extra element dilutes the rest. Keep interfaces focused on what's relevant — and recall the aesthetic-usability effect (NNG): a clean, coherent surface is perceived as more usable, so minimalism and polish pull in the same direction.

**9. Help users recognize, diagnose, and recover from errors** (Nielsen heuristic). When something goes wrong, say so in plain language, name the problem precisely, and offer a constructive way out. This is where empty states and error states live: a container with no data should explain what would go there and how to fill it; an error state should be specific and actionable, never a dead end.

**10. Help and documentation** (Nielsen heuristic). Ideally the system needs no explanation, but when help is warranted it should be easy to find, scoped to the user's task, and concrete about the steps to take — placed in context rather than buried.

## Forms

Forms are where interaction discipline pays off most directly:

- Pair every input with a persistent, visible label (placeholder text is not a label — it vanishes on focus and fails recall, heuristic 6).
- Validate at a helpful moment — on blur or on submit for most fields, not aggressively on every keystroke — and place each error message adjacent to the field it concerns, not collected far away (heuristics 1 and 9).
- Prevent errors before they happen: constrain inputs, supply sensible defaults, mark required versus optional clearly (heuristic 5).
- Preserve the user's entered data across validation failures and navigation; never silently discard it (heuristic 3).

## Navigation and wayfinding

- The user can always answer "where am I, and how did I get here?" — current location is indicated and the path back is clear (heuristics 1 and 3).
- Navigation labels and structure are consistent across the product; the same destination is named the same way everywhere (heuristic 4).
- Primary paths are obvious and reachable; secondary paths are available without cluttering the primary view (heuristics 7 and 8).
