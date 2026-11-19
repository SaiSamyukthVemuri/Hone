import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OVER_INVITE_CONFIRM_LABEL, OVER_INVITE_SUBMIT_LABEL, OverInviteConfirm } from "@/components/waitlist/over-invite-confirm";
import { buildOverInvitePreview } from "@/lib/waitlist/over-invite-preview";

const render = (over: { fit?: number; extra?: number; n?: number; notice?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(OverInviteConfirm, {
      action: () => undefined,
      preview: buildOverInvitePreview({ fit: over.fit ?? 0, active: 3, expiringSoon: 6, extra: over.extra ?? 10 }),
      recipients: Array.from({ length: over.n ?? 10 }, (_, i) => ({ entryId: `e${i}`, name: `Person ${i}` })),
      batchKey: "key-1",
      notice: over.notice ?? null,
    }),
  );

describe("OverInviteConfirm", () => {
  it("at fit=0 the owner can still choose and confirm: the button is present and never disabled", () => {
    const h = render({ fit: 0 });
    expect(h).toContain(OVER_INVITE_SUBMIT_LABEL);
    expect(h).not.toMatch(/<button[^>]*disabled/);
    expect(h).toContain("0 estimated appointments available");
    expect(h).toContain("Some clients may find no availability.");
  });
  it("shows the estimate, the active count, the studio-wide expirations and the resulting total", () => {
    const h = render({ fit: 5, extra: 10 });
    expect(h).toContain("5 estimated appointments available · 3 invitations active · Send 10 more → 13 active invitations");
    expect(h).toContain("6 invitations across the studio expire within 24 hours");
  });
  it("selects nobody by default and has no ceiling on how many can be chosen", () => {
    const h = render({ n: 1200 });
    expect((h.match(/name="entryId"/g) ?? []).length).toBe(1200);
    expect(h).not.toMatch(/name="entryId"[^>]*checked/);
    expect(h).not.toMatch(/maxLength|max="/);
  });
  it("the confirmation is an explicit, unticked box with the agreed wording", () => {
    const h = render();
    expect(h).toContain(OVER_INVITE_CONFIRM_LABEL);
    expect(h).toMatch(/name="confirmed"/);
    expect(h).not.toMatch(/name="confirmed"[^>]*checked/);
  });
  it("carries what the owner saw and a batch key, so a re-check compares and a double submit is one batch", () => {
    const h = render({ fit: 0, extra: 10 });
    expect(h).toContain('name="batchKey" value="key-1"');
    expect(h).toContain('name="shownFit" value="0"');
    expect(h).toContain('name="shownActive" value="3"');
    expect(h).toContain('name="shownExtra" value="10"');
  });
  it("shows a notice as an alert only when there is one", () => {
    expect(render()).not.toContain("over-invite-notice");
    expect(render({ notice: "The numbers changed. Check them and confirm again." })).toContain('role="alert"');
  });
  it("the expiring line is the studio-wide 24-hour wording, and a changed expiring count alone is not a reason to re-ask", async () => {
    expect(render({ fit: 2 })).toContain("across the studio expire within 24 hours");
    const { recheckBeforeSend } = await import("@/lib/waitlist/over-invite-batch");
    const a = buildOverInvitePreview({ fit: 2, active: 3, expiringSoon: 1, extra: 4 });
    const b = buildOverInvitePreview({ fit: 2, active: 3, expiringSoon: 9, extra: 4 });
    expect(recheckBeforeSend(a, b)).toBe("send");
  });
  it("carries EXACTLY the shown numbers and the batch key as hidden inputs, and nothing else (recipient ids are checkboxes, not hidden fields)", () => {
    const h = render({ fit: 3, extra: 4 });
    const names = [...h.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => /name="([^"]+)"/.exec(m[0])?.[1]).sort();
    expect(names).toEqual(["batchKey", "shownActive", "shownExtra", "shownFit"]);
    expect(h).not.toMatch(/name="(shownExpiring|expiringSoon|expiring)/i);
  });
});
