import { describe, expect, it } from "vitest";

import { isNotRequestableCollaborator422 } from "./copilot-classify";

describe(isNotRequestableCollaborator422, () => {
  it("returns true for the exact collaborators-422 body", () => {
    expect(
      isNotRequestableCollaborator422(
        "HTTP 422: Reviews may only be requested from collaborators.",
      ),
    ).toBe(true);
  });

  it("returns true case-insensitively (mixed-case body)", () => {
    expect(
      isNotRequestableCollaborator422(
        "May Only Be Requested From Collaborators",
      ),
    ).toBe(true);
  });

  it("returns false for a 403 / other failure body", () => {
    expect(
      isNotRequestableCollaborator422("HTTP 403: Resource not accessible"),
    ).toBe(false);
  });

  it("returns false for an empty stderr", () => {
    expect(isNotRequestableCollaborator422("")).toBe(false);
  });
});
