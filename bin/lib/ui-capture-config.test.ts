import { describe, expect, it } from "vitest";

import { buildCaptureConfig } from "./ui-capture-config";

const OTP =
  "/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

describe("buildCaptureConfig", () => {
  it("gives a fragment route and the bare root route distinct snapshot and screenshot paths", () => {
    const cfg = buildCaptureConfig({
      worktree: "/wt",
      baseUrl: "http://localhost:5173",
      login: null,
      targets: [
        { route: OTP, state: "signed-out visitor" },
        { route: "/", state: "signed-out visitor" },
      ],
    });

    const [otp, root] = cfg.targets;
    expect(otp.snapshotPath).not.toBe(root.snapshotPath);

    const shotsFor = (route: string) =>
      Object.entries(cfg.names)
        .filter(([key]) => key.startsWith(`${route}|`))
        .map(([, file]) => file);
    const otpShots = shotsFor(OTP);
    const rootShots = shotsFor("/");
    expect(otpShots.length).toBeGreaterThan(0);
    expect(rootShots.length).toBeGreaterThan(0);
    expect(otpShots.filter((f) => rootShots.includes(f))).toEqual([]);
  });
});
