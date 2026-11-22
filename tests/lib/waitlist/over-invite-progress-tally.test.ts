import { describe, expect, it } from "vitest";
import { tallyItems } from "@/lib/waitlist/over-invite-progress";

// An item the worker claimed but could not start (a transient failure leaves it claimed until its lease runs out) is shown to the owner as
// WAITING, like a queued one: never as sent, never hidden.
describe("batch progress tally", () => {
  const row = (state: string) => ({ state, reason_class: null, issued_at: null }) as never;
  it("counts claimed and pending items as waiting, and neither as sent", () => {
    const t = tallyItems([row("pending"), row("claimed"), row("claimed"), row("sent")]);
    expect(t.waiting).toBe(3);
    expect(t.sent).toBe(1);
  });
});
