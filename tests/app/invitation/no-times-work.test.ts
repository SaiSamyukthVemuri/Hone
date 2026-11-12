import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 0325 recipient wiring. The database commands are proved in the DB suite; this pins the app's side of them.

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { declineWithAnswers, requestWithdrawal } from "@/lib/booking/waitlist-invitation";
import { ANSWER_PROBLEM_COPY, DECLINE_ANSWER_MAX, NO_TIMES_WORK_LABELS, validateNoTimesWork } from "@/lib/waitlist/decline-responses";
import { DECLINE_CONFIRMATION, NO_TIMES_WORK_NOTICE, WITHDRAWAL_CONFIRMATION } from "@/lib/waitlist/decline-copy";
import { waitlistDeclineAnswersEnabled } from "@/lib/waitlist/decline-answers-gate";
import { NoTimesWorkForm } from "@/app/features/waitlist-invitation/NoTimesWorkForm";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ACTIONS = read("app/invitation/[token]/actions.ts");
const slice = (name: string, next: string) => {
  const i = ACTIONS.indexOf(`export async function ${name}`);
  return ACTIONS.slice(i, ACTIONS.indexOf(next, i));
};
const answers = slice("noTimesWorkAction", "export async function noLongerNeedAction");
const withdrawal = slice("noLongerNeedAction", "export async function timesDontWorkAction");

const RAW = "a1".repeat(32); // the wrapper's RAW_SECRET shape: 64 lowercase hex characters
beforeEach(() => vi.clearAllMocks());

describe("the notice under the two answer fields is Sam's, word for word", () => {
  it("is pinned exactly", () => {
    expect(NO_TIMES_WORK_NOTICE).toBe(
      "Within your studio, only the studio owner can see your answers. They're used to arrange a time with you. Hone hides your answers from the studio's view and from new exports 30 days after your request closes or 90 days after you send them, whichever comes first. Hone deletes them from its active database during the next daily cleanup. Backup copies expire within a further seven days. Copies the studio has already downloaded are managed by the studio. Please don't include medical or health details.",
    );
  });
  it("is not shown until the person opens the form (the revealed form is proved in the mounted test)", () => {
    const html = renderToStaticMarkup(createElement(NoTimesWorkForm, { pending: false, onSubmit: () => {}, onNoLongerNeed: () => {} }));
    expect(html.replace(/&#x27;/g, "'")).not.toContain(NO_TIMES_WORK_NOTICE);
    expect(`${NO_TIMES_WORK_NOTICE} ${DECLINE_CONFIRMATION} ${WITHDRAWAL_CONFIRMATION}`).not.toMatch(/all your information|everything/i);
  });
});

describe("the form, before it is opened", () => {
  const html = renderToStaticMarkup(createElement(NoTimesWorkForm, { pending: false, onSubmit: () => {}, onNoLongerNeed: () => {} }));
  it("offers only the two choices: no question, no field, no notice", () => {
    expect(html).toContain("None of these times work");
    expect(html).toContain(NO_TIMES_WORK_LABELS.noLongerNeed);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(NO_TIMES_WORK_LABELS.better);
    expect(html).not.toContain("Send response");
  });
  it("caps each answer at the contract's 1000 characters", () => {
    expect(DECLINE_ANSWER_MAX).toBe(1000);
  });
});

describe("validation follows the frozen contract", () => {
  it("requires both, trimmed", () => {
    expect(validateNoTimesWork({ why: "  ", better: "Tuesdays" })).toEqual({ ok: false, problems: { why: "required" } });
    expect(validateNoTimesWork({ why: "x", better: "" })).toEqual({ ok: false, problems: { better: "required" } });
    expect(validateNoTimesWork({ why: " a ", better: " b " })).toEqual({ ok: true, answers: { why: "a", better: "b" } });
  });
  it("accepts 1000, refuses 1001", () => {
    expect(validateNoTimesWork({ why: "a".repeat(1000), better: "b" }).ok).toBe(true);
    expect(validateNoTimesWork({ why: "a".repeat(1001), better: "b" })).toEqual({ ok: false, problems: { why: "too_long" } });
  });
  it("allows newline, tab and carriage return; refuses other control characters", () => {
    expect(validateNoTimesWork({ why: "a\nb\tc\r", better: "b" }).ok).toBe(true);
    for (const c of ["\u0000", "\u0007", "\u000b", "\u001b", "\u007f"]) {
      expect(validateNoTimesWork({ why: `a${c}b`, better: "b" })).toEqual({ ok: false, problems: { why: "invalid_characters" } });
    }
  });
  it("has copy for every problem", () => {
    for (const p of ["required", "too_long", "invalid_characters"] as const) expect(ANSWER_PROBLEM_COPY[p].length).toBeGreaterThan(0);
  });
});

describe("the command wrappers", () => {
  const SECRET = RAW;
  it("declined carries the invitation id for the post-commit email, and only then", async () => {
    h.rpc.mockResolvedValue({ data: [{ result: "declined", invitation_id: "11111111-1111-4111-8111-111111111111" }], error: null });
    const out = await declineWithAnswers({ rawToken: SECRET, rawCapability: SECRET, whyNotWork: "w", betterTimes: "b" });
    expect(out).toEqual({ kind: "declined", invitationId: "11111111-1111-4111-8111-111111111111" });
    expect(h.rpc).toHaveBeenCalledWith("decline_waitlist_invitation_with_answers", {
      p_raw_token: SECRET, p_raw_capability: SECRET, p_why_not_work: "w", p_better_times: "b",
    });
  });
  it("a declined without an id, an unknown code, an error and a throw all fail closed", async () => {
    for (const data of [[{ result: "declined", invitation_id: null }], [{ result: "wat" }], [], null]) {
      h.rpc.mockResolvedValue({ data, error: null });
      const out = await declineWithAnswers({ rawToken: SECRET, rawCapability: SECRET, whyNotWork: "w", betterTimes: "b" });
      expect(out.kind).toBe("unavailable");
    }
    h.rpc.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await declineWithAnswers({ rawToken: SECRET, rawCapability: SECRET, whyNotWork: "w", betterTimes: "b" })).kind).not.toBe("declined");
    h.rpc.mockRejectedValue(new Error("boom"));
    expect((await declineWithAnswers({ rawToken: SECRET, rawCapability: SECRET, whyNotWork: "w", betterTimes: "b" })).kind).not.toBe("declined");
  });
  it("a malformed token or capability never reaches the database", async () => {
    expect((await declineWithAnswers({ rawToken: "x", rawCapability: SECRET, whyNotWork: "w", betterTimes: "b" })).kind).toBe("invalid_token");
    expect((await declineWithAnswers({ rawToken: SECRET, rawCapability: "x", whyNotWork: "w", betterTimes: "b" })).kind).toBe("proof_invalid");
    expect((await requestWithdrawal({ rawToken: "x", rawCapability: SECRET })).kind).toBe("invalid_token");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("the withdrawal reports recorded only for recorded", async () => {
    h.rpc.mockResolvedValue({ data: [{ result: "recorded" }], error: null });
    const ok = await requestWithdrawal({ rawToken: SECRET, rawCapability: SECRET });
    expect(ok).toEqual({ kind: "recorded" });
    h.rpc.mockResolvedValue({ data: [{ result: "something_else" }], error: null });
    expect((await requestWithdrawal({ rawToken: SECRET, rawCapability: SECRET })).kind).not.toBe("recorded");
  });
});

describe("the server actions", () => {
  it("are off unless the flag is exactly '1', and off writes nothing", () => {
    expect(read("lib/waitlist/decline-answers-gate.ts")).toMatch(/process\.env\.WAITLIST_DECLINE_ANSWERS === "1"/);
    delete process.env.WAITLIST_DECLINE_ANSWERS;
    expect(waitlistDeclineAnswersEnabled()).toBe(false);
    for (const a of [answers, withdrawal]) {
      const off = a.indexOf("if (!waitlistDeclineAnswersEnabled()) return loadInvitationAction(rawToken);");
      expect(off).toBeGreaterThan(0);
      expect(off).toBeLessThan(a.indexOf("limitPublicSlots"));
    }
  });
  it("are throttled before any read, and re-validate the answers on the server before the command", () => {
    expect(answers.indexOf("limitPublicSlots")).toBeLessThan(answers.indexOf("loadContext("));
    expect(answers.indexOf("validateNoTimesWork(")).toBeLessThan(answers.indexOf("declineWithAnswers("));
  });
  it("hand the owner emails to the dispatcher only on `declined`, after the commit, without blocking and never to the browser", () => {
    expect((answers.match(/dispatchDeclineOwnerEmail\(/g) ?? []).length).toBe(1);
    const call = answers.indexOf("dispatchDeclineOwnerEmail(");
    const guard = answers.lastIndexOf('out.kind === "declined"', call);
    expect(guard).toBeGreaterThan(0);
    expect(call - guard).toBeLessThan(400);
    expect(answers.slice(guard, call)).toContain("after(");
    // the id is a local used only in that call; no returned object carries it
    expect(answers).not.toMatch(/return \{[^}]*invitationId/);
  });
  it("the plain decline and the times-feedback decline are refused while the flag is on, before any read", () => {
    const plain = ACTIONS.slice(ACTIONS.indexOf("export async function declineInvitationAction"));
    const guard = plain.indexOf("if (waitlistDeclineAnswersEnabled()) return loadInvitationAction(rawToken);");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(plain.indexOf("readCapability("));
    const feedback = ACTIONS.slice(ACTIONS.indexOf("export async function timesDontWorkAction"));
    expect(feedback.slice(0, feedback.indexOf("limitPublicSlots"))).toContain("if (waitlistDeclineAnswersEnabled()) return loadInvitationAction(rawToken);");
  });
  it("never log or echo the answers", () => {
    for (const a of [answers, withdrawal]) expect(a).not.toMatch(/console\.|logger|log\w*\(/);
  });
  it("the confirmation is returned only for declined and already_declined", () => {
    expect((answers.match(/answered: "answers"/g) ?? []).length).toBe(2);
    expect(answers).toContain('out.kind === "already_declined"');
    expect(withdrawal).toContain('out.kind === "recorded"');
  });
  it("the screen shows the form only when both handlers are given, and keeps the old footers otherwise", () => {
    const screen = read("app/features/waitlist-invitation/InvitationScreen.tsx");
    expect(screen).toContain("onNoTimesWork && onNoLongerNeed");
    expect(screen).toContain("I can’t make any of these");
    // The plain decline button is only in the ELSE branch of the answers form, so it is not on the page while the form is.
    const form = screen.indexOf("onNoTimesWork && onNoLongerNeed ? (");
    expect(form).toBeGreaterThan(0);
    expect(screen.indexOf("onClick={onDecline}")).toBeGreaterThan(form);
    expect((screen.match(/onClick=\{onDecline\}/g) ?? []).length).toBe(1);
    const container = read("app/invitation/[token]/InvitationContainer.tsx");
    expect(container).toContain("declineAnswers\n          ? (a: { why: string; better: string })");
    expect(container).toContain("onNoLongerNeed={declineAnswers ?");
    expect(screen).toContain("{DECLINE_CONFIRMATION}");
    expect(screen).toContain("{WITHDRAWAL_CONFIRMATION}");
  });
  it("the confirmation text is the contract's", () => {
    expect(DECLINE_CONFIRMATION).toBe("Nothing is booked. You're still on the waitlist in your original place. The studio will contact you to arrange a suitable time.");
  });
});
