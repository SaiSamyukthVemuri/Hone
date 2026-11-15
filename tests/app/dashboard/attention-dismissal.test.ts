import { describe, expect, it } from "vitest";
import {
  attentionIdentity, attentionInstanceToken, attentionItemKey, unpaidItemKey,
} from "@/lib/dashboard/attention-identity";
import {
  isDismissed, partitionByDismissal, unpaidStaysDismissed,
} from "@/lib/dashboard/attention-dismissal";
import { readFileSync } from "node:fs";

const intake = { id: "intake:c1:intake_review", kind: "intake_review" as const };
const charting = { id: "appointment:c1:a1:charting", kind: "charting" as const };
const memory = { id: "treatment_memory:c1", kind: "treatment_memory" as const };

describe("attention identity", () => {
  it("the key is the structured id, never rendered text", () => {
    expect(attentionItemKey({ ...charting, label: "Charting needed" } as typeof charting)).toBe(charting.id);
    expect(unpaidItemKey("a9")).toBe("unpaid:a9");
  });
  it("is stable across renders", () => {
    expect(attentionIdentity(intake, "2026-10-01T10:00:00Z")).toEqual(attentionIdentity(intake, "2026-10-01T10:00:00Z"));
  });
  it("a new intake submission or reaction changes the token; unstamped kinds are constant", () => {
    expect(attentionInstanceToken(intake, "2026-10-01T10:00:00Z")).not.toBe(attentionInstanceToken(intake, "2026-10-20T10:00:00Z"));
    expect(attentionInstanceToken(memory, "r1")).not.toBe(attentionInstanceToken(memory, "r2"));
    expect(attentionInstanceToken(charting, "anything")).toBe("1");
  });
  it("a stamped kind with no stamp gets a token that never matches", () => {
    expect(attentionInstanceToken(intake, null)).toBe("unstamped");
    expect(attentionInstanceToken(memory, "  ")).toBe("unstamped");
  });
});

describe("dismissal matching", () => {
  const stored = [attentionIdentity(intake, "t1"), attentionIdentity(charting, null)];
  it("hides only the same key AND token", () => {
    expect(isDismissed(attentionIdentity(intake, "t1"), stored)).toBe(true);
    expect(isDismissed(attentionIdentity(charting, null), stored)).toBe(true);
  });
  it("a NEW issue for the same client still shows", () => {
    expect(isDismissed(attentionIdentity(intake, "t2"), stored)).toBe(false);
    expect(isDismissed(attentionIdentity(memory, "r1"), stored)).toBe(false);
  });
  it("an item whose instance cannot be told is shown, not hidden", () => {
    expect(isDismissed(attentionIdentity(intake, null), [{ itemKey: intake.id, instanceToken: "unstamped" }])).toBe(false);
  });
  it("restore: removing the stored dismissal shows it again", () => {
    const live: Array<{ id: string; kind: "intake_review" | "charting" }> = [intake, charting];
    const id = (i: (typeof live)[number]) => attentionIdentity(i, i.id === intake.id ? "t1" : null);
    expect(partitionByDismissal(live, id, stored)).toEqual({ shown: [], dismissed: live });
    expect(partitionByDismissal(live, id, [])).toEqual({ shown: live, dismissed: [] });
  });
  it("unpaid rule (a): lower or equal stays dismissed, a rise reappears", () => {
    expect(unpaidStaysDismissed(6000, 3000)).toBe(true);
    expect(unpaidStaysDismissed(6000, 6000)).toBe(true);
    expect(unpaidStaysDismissed(6000, 8500)).toBe(false);
  });
});

describe("dismissal never touches money", () => {
  it("the pure modules import no payment, message or charge code", () => {
    for (const f of [
      "lib/dashboard/attention-identity.ts",
      "lib/dashboard/attention-dismissal.ts",
    ]) {
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      expect(src).not.toMatch(/from\s+["']@\/lib\/(billing|stripe|email|sms|supabase)/);
      expect(src).not.toMatch(/payment_charge_attempts|appointment_settlements|stripe|sendEmail|sendSms/i);
    }
  });
});
