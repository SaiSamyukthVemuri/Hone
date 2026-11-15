import { describe, expect, it } from "vitest";
import { buildSetupCardState } from "@/lib/dashboard/setup-card-model";
import type { NewClientBlocker, NewClientReadiness } from "@/lib/booking/new-client-readiness";

const complete = {
  send_confirmation_emails: true,
  postcare_aftercare_text: "Synthetic aftercare text",
  cancellation_policy_text: "Synthetic cancellation policy",
  no_show_policy_text: "Synthetic no-show policy",
};
const b = (key: NewClientBlocker["key"]): NewClientBlocker => ({ key, label: `${key} label`, href: `/settings/${key}` });
const notReady = (keys: NewClientBlocker["key"][], unavailable: never[] | string[] = []): NewClientReadiness =>
  ({ status: "not_ready", blockers: keys.map(b), nextStep: keys.length ? b(keys[0]) : null, unavailable } as NewClientReadiness);

describe("buildSetupCardState", () => {
  it("is hidden for a non-owner, whatever the readiness", () => {
    expect(buildSetupCardState({ isOwner: false, readiness: notReady(["availability"]), studio: complete })).toEqual({ kind: "hidden" });
  });

  it("is hidden when readiness is null (not read) or everything is complete", () => {
    expect(buildSetupCardState({ isOwner: true, readiness: null, studio: complete }).kind).toBe("hidden");
    expect(buildSetupCardState({ isOwner: true, readiness: { status: "ready" }, studio: complete }).kind).toBe("hidden");
  });

  it("a structural blocker is INCOMPLETE and names the next step", () => {
    const s = buildSetupCardState({ isOwner: true, readiness: notReady(["availability", "wait_admission"]), studio: complete });
    expect(s).toMatchObject({ kind: "incomplete", remaining: 1, listMayBeIncomplete: false });
    expect((s as { next: NewClientBlocker }).next.key).toBe("availability");
  });

  it("only owner-choice blockers is PAUSED BY OWNER, not unfinished setup", () => {
    const s = buildSetupCardState({ isOwner: true, readiness: notReady(["admission_closed"]), studio: complete });
    expect(s.kind).toBe("paused_by_owner");
    const w = buildSetupCardState({ isOwner: true, readiness: notReady(["wait_admission"]), studio: complete });
    expect(w.kind).toBe("paused_by_owner");
  });

  it("an unreadable authority next to only-choice blockers is NOT called paused", () => {
    const s = buildSetupCardState({ isOwner: true, readiness: notReady(["admission_closed"], ["availability"]), studio: complete });
    expect(s).toMatchObject({ kind: "incomplete", listMayBeIncomplete: true });
  });

  it("unknown readiness stays unknown", () => {
    expect(buildSetupCardState({ isOwner: true, readiness: { status: "unknown", unavailable: ["services"] }, studio: complete }).kind).toBe("unknown");
  });

  it("ready booking with launch items outstanding is FINISH LAUNCH", () => {
    expect(buildSetupCardState({ isOwner: true, readiness: { status: "ready" }, studio: { ...complete, postcare_aftercare_text: "" } }).kind).toBe("finish_launch");
    expect(buildSetupCardState({ isOwner: true, readiness: { status: "ready" }, studio: { ...complete, send_confirmation_emails: false } }).kind).toBe("finish_launch");
  });
});
