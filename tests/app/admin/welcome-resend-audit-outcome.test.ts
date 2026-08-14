import { describe, expect, it } from "vitest";
import { auditOutcomeFor } from "@/app/admin/studios/[id]/audit-outcome";
import { ADMIN_ACTION_OUTCOMES } from "@/lib/audit/admin-actions";
import type { WelcomeEmailResult } from "@/lib/email/send-welcome";

// Finding 3: the resend audit outcome must be truthful, not a blanket
// "succeeded" for everything that isn't a hard failure.
describe("welcome-email resend audit outcome mapping", () => {
  it("maps each send result to the correct closed-set outcome", () => {
    expect(auditOutcomeFor("sent")).toBe("succeeded");
    expect(auditOutcomeFor("failed")).toBe("failed");
    expect(auditOutcomeFor("not_configured")).toBe("blocked");
    expect(auditOutcomeFor("already_in_progress")).toBe("blocked");
  });

  it("never reports 'succeeded' for a result that sent nothing", () => {
    for (const s of ["not_configured", "already_in_progress"] as const) {
      expect(auditOutcomeFor(s)).not.toBe("succeeded");
    }
  });

  it("only a genuine send is 'succeeded'", () => {
    const results: WelcomeEmailResult[] = [
      "sent",
      "failed",
      "not_configured",
      "already_in_progress",
    ];
    const succeeded = results.filter((r) => auditOutcomeFor(r) === "succeeded");
    expect(succeeded).toEqual(["sent"]);
  });

  it("every mapped outcome is a valid admin-action outcome", () => {
    const results: WelcomeEmailResult[] = [
      "sent",
      "failed",
      "not_configured",
      "already_in_progress",
    ];
    for (const r of results) {
      expect(ADMIN_ACTION_OUTCOMES).toContain(auditOutcomeFor(r));
    }
  });
});
