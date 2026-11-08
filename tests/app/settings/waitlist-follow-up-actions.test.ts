import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: vi.fn(),
  cmd: { mark: vi.fn(), keep: vi.fn(), erase: vi.fn(), link: vi.fn() },
}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: h.session }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/waitlist/followups-owner", () => ({
  markDeclineHandled: h.cmd.mark, keepWithdrawal: h.cmd.keep, eraseAnswers: h.cmd.erase, linkFollowUpAppointment: h.cmd.link,
}));
import { eraseAnswersAction, keepWithdrawalAction, linkAppointmentAction, markHandledAction, noticeFor } from "@/app/(app)/settings/waitlist/follow-up-actions";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const F = "33333333-3333-4333-8333-333333333333";
const AP = "44444444-4444-4444-8444-444444444444";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const target = async (p: Promise<void>) => { try { await p; } catch (e) { return String((e as Error).message); } return "no redirect"; };

beforeEach(() => {
  vi.clearAllMocks();
  h.session.mockResolvedValue({ practitioner: { role: "owner", user_id: USER }, studio: { id: STUDIO } });
  for (const c of Object.values(h.cmd)) c.mockResolvedValue("done");
});

describe("the owner follow-up commands", () => {
  const all = [
    ["mark handled", markHandledAction, h.cmd.mark, { followupId: F }, [STUDIO, USER, F]],
    ["keep", keepWithdrawalAction, h.cmd.keep, { followupId: F }, [STUDIO, USER, F]],
    ["erase", eraseAnswersAction, h.cmd.erase, { followupId: F }, [STUDIO, USER, F]],
    ["link", linkAppointmentAction, h.cmd.link, { followupId: F, appointmentId: AP }, [STUDIO, USER, F, AP]],
  ] as const;
  for (const [name, action, cmd, fields, args] of all) {
    it(`${name}: studio and actor come from the session, and success redirects to the anchor`, async () => {
      expect(await target(action(form({ ...fields, studioId: "x", actorUserId: "y", p_actor_user_id: "z" })))).toBe("REDIRECT:/settings/waitlist?fu=done#follow-up");
      expect(cmd).toHaveBeenCalledWith(...args);
    });
    it(`${name}: a non-owner, a missing session user or a bad id calls nothing`, async () => {
      h.session.mockResolvedValue({ practitioner: { role: "practitioner", user_id: USER }, studio: { id: STUDIO } });
      expect(await target(action(form(fields)))).toContain("fu=refused");
      h.session.mockResolvedValue({ practitioner: { role: "owner", user_id: null }, studio: { id: STUDIO } });
      expect(await target(action(form(fields)))).toContain("fu=refused");
      h.session.mockResolvedValue({ practitioner: { role: "owner", user_id: USER }, studio: { id: STUDIO } });
      expect(await target(action(form({ ...fields, followupId: "not-a-uuid" })))).toContain("fu=refused");
      expect(cmd).not.toHaveBeenCalled();
    });
    it(`${name}: a failure is shown, never silent`, async () => {
      cmd.mockResolvedValue("unavailable");
      expect(await target(action(form(fields)))).toContain("fu=failed");
      cmd.mockResolvedValue("not_owner");
      expect(await target(action(form(fields)))).toContain("fu=refused");
      cmd.mockResolvedValue("already");
      expect(await target(action(form(fields)))).toContain("fu=already");
    });
  }
  it("link also refuses a bad appointment id", async () => {
    expect(await target(linkAppointmentAction(form({ followupId: F, appointmentId: "nope" })))).toContain("fu=refused");
    expect(h.cmd.link).not.toHaveBeenCalled();
  });
  it("every outcome maps to a closed notice", () => {
    expect(noticeFor("done")).toBe("done");
    expect(noticeFor("already")).toBe("already");
    expect(noticeFor("unavailable")).toBe("failed");
    for (const o of ["not_found", "not_owner", "already_closed", "appointment_not_found", "appointment_mismatch", "appointment_not_bookable", "appointment_already_linked", "entry_not_waiting"] as const) expect(noticeFor(o)).toBe("refused");
  });
  it("the redirect carries only a closed code: no id, name or answer", async () => {
    const to = await target(markHandledAction(form({ followupId: F })));
    expect(to).not.toContain(F);
  });
  it("actions read the session user (getUser), take no studio or actor from the form, and never log", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/settings/waitlist/follow-up-actions.ts"), "utf8");
    expect(src).toContain("getCurrentPractitionerWithStudio");
    expect(src).not.toMatch(/formData\.get\("(studio|actor)/i);
    expect(src).not.toMatch(/console\.|logger/);
  });
});
