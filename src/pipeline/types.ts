export type PhaseResult =
  | { status: "ok" }
  | { status: "retry"; reason: string }
  | { status: "needs-human"; reason: string }
  | { status: "failed"; reason: string };
