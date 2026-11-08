import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn(), boom: false }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({
    rpc: (...a: unknown[]) => {
      if (h.boom) throw new Error("synthetic");
      return h.rpc(...a);
    },
  }) }));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOLLOWUP_READ_COLUMNS, eraseAnswers, keepWithdrawal, linkFollowUpAppointment, markDeclineHandled, readFollowUps, readFollowUpStatuses } from "@/lib/waitlist/followups-owner";

const S = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const F = "33333333-3333-4333-8333-333333333333";
const AP = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  h.rpc.mockReset();
  h.boom = false;
});

const row = (over: Record<string, unknown> = {}) => ({
  followup_id: F, kind: "decline", entry_id: "e1", invitation_id: "i1", client_name: "Synthetic Person", client_email: "p@example.test",
  opened_at: "2026-11-09T10:00:00Z", status: "open", why_not_work: "WHYMARK", better_times: "BETTERMARK", answers_erased_at: null,
  submitted_at: "2026-11-09T10:00:00Z", closed_at: null, erase_by: "2027-02-07T10:00:00Z", ...over,
});

describe("the owner reads", () => {
  it("call the contract's functions with the studio and the verified actor", async () => {
    h.rpc.mockResolvedValue({ data: [row()], error: null });
    const out = await readFollowUps(S, A);
    expect(h.rpc).toHaveBeenCalledWith("read_waitlist_followups", { p_studio_id: S, p_actor_user_id: A });
    expect(out).toMatchObject({ kind: "ok", rows: [{ followupId: F, kind: "decline", whyNotWork: "WHYMARK", eraseBy: "2027-02-07T10:00:00Z" }] });
  });
  it("the row type does not carry the email address to the page", async () => {
    h.rpc.mockResolvedValue({ data: [row()], error: null });
    const out = await readFollowUps(S, A);
    expect(JSON.stringify(out)).not.toContain("example.test");
  });
  it("no actor means no call; an error, a bad payload or a throw is unknown, never an empty list", async () => {
    expect(await readFollowUps(S, null)).toEqual({ kind: "unknown" });
    expect(h.rpc).not.toHaveBeenCalled();
    h.rpc.mockResolvedValue({ data: null, error: { code: "x" } });
    expect(await readFollowUps(S, A)).toEqual({ kind: "unknown" });
    h.rpc.mockResolvedValue({ data: [row({ kind: "wat" })], error: null });
    expect(await readFollowUps(S, A)).toEqual({ kind: "unknown" });
    h.rpc.mockResolvedValue({ data: [row({ status: "wat" })], error: null });
    expect(await readFollowUps(S, A)).toEqual({ kind: "unknown" });
    h.boom = true;
    expect(await readFollowUps(S, A)).toEqual({ kind: "unknown" });
  });
  it("zero rows is an empty list (not an owner returns zero rows by contract)", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    expect(await readFollowUps(S, A)).toEqual({ kind: "ok", rows: [] });
  });
  it("the status read is ONE call for many invitations, returns a status only, and treats a missing row as none", async () => {
    h.rpc.mockResolvedValue({ data: [{ invitation_id: "i1", status: "open" }, { invitation_id: "i2", status: "handled" }], error: null });
    const out = await readFollowUpStatuses(S, A, ["i1", "i2", "i3"]);
    expect(out).toEqual({ kind: "ok", byInvitation: new Map([["i1", "open"], ["i2", "handled"]]) });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("read_waitlist_followup_status", { p_studio_id: S, p_actor_user_id: A, p_invitation_ids: ["i1", "i2", "i3"] });
    h.rpc.mockResolvedValue({ data: [{ invitation_id: "i1", status: "wat" }], error: null });
    expect(await readFollowUpStatuses(S, A, ["i1"])).toEqual({ kind: "unknown" });
    h.rpc.mockResolvedValue({ data: null, error: { code: "x" } });
    expect(await readFollowUpStatuses(S, A, ["i1"])).toEqual({ kind: "unknown" });
    expect(await readFollowUpStatuses(S, null, ["i1"])).toEqual({ kind: "unknown" });
  });
  it("more than 500 ids is never sent: too_many without a call; a 22023 refusal is too_many, not unknown", async () => {
    const many = Array.from({ length: 501 }, (_, i) => `i${i}`);
    expect(await readFollowUpStatuses(S, A, many)).toEqual({ kind: "too_many" });
    expect(h.rpc).not.toHaveBeenCalled();
    h.rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
    expect(await readFollowUpStatuses(S, A, ["i1"])).toEqual({ kind: "too_many" });
  });
  it("no invitations means no call", async () => {
    expect(await readFollowUpStatuses(S, A, [])).toEqual({ kind: "ok", byInvitation: new Map() });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("the owner commands", () => {
  const cases: Array<[string, () => Promise<string>, string, Record<string, string>, Array<[string, string]>]> = [
    ["mark handled", () => markDeclineHandled(S, A, F), "mark_waitlist_decline_handled", { p_followup_id: F }, [["handled", "done"], ["already_handled", "already"], ["not_found", "not_found"], ["not_owner", "not_owner"], ["already_closed", "already_closed"]]],
    ["keep", () => keepWithdrawal(S, A, F), "keep_waitlist_withdrawal", { p_followup_id: F }, [["kept", "done"], ["already_resolved", "already"], ["not_found", "not_found"], ["not_owner", "not_owner"]]],
    ["erase", () => eraseAnswers(S, A, F), "erase_waitlist_decline_answers", { p_followup_id: F }, [["erased", "done"], ["already_erased", "already"], ["not_found", "not_found"], ["not_owner", "not_owner"]]],
    ["link", () => linkFollowUpAppointment(S, A, F, AP), "link_waitlist_followup_appointment", { p_followup_id: F, p_appointment_id: AP }, [
      ["booked", "done"], ["already_booked", "already"], ["not_found", "not_found"], ["not_owner", "not_owner"], ["appointment_not_found", "appointment_not_found"],
      ["appointment_mismatch", "appointment_mismatch"], ["appointment_not_bookable", "appointment_not_bookable"], ["appointment_already_linked", "appointment_already_linked"], ["entry_not_waiting", "entry_not_waiting"],
    ]],
  ];
  for (const [name, call, fn, extra, map] of cases) {
    it(`${name}: calls ${fn} with studio and actor first, and maps every contract code`, async () => {
      for (const [code, outcome] of map) {
        h.rpc.mockReset();
        h.rpc.mockResolvedValue({ data: [{ result: code }], error: null });
        expect(await call()).toBe(outcome);
        expect(h.rpc).toHaveBeenCalledWith(fn, { p_studio_id: S, p_actor_user_id: A, ...extra });
      }
    });
    it(`${name}: an unknown code, an error, no rows or a throw is unavailable, never success`, async () => {
      for (const r of [{ data: [{ result: "wat" }], error: null }, { data: null, error: { code: "x" } }, { data: [], error: null }, { data: [{}], error: null }]) {
        h.rpc.mockReset();
        h.rpc.mockResolvedValue(r);
        expect(await call()).toBe("unavailable");
      }
      h.boom = true;
      expect(await call()).toBe("unavailable");
    });
  }
});

describe("the read's contract fields", () => {
  it("lists erase_by, submitted_at and closed_at, and the adapter reads every listed column", () => {
    for (const c of ["erase_by", "submitted_at", "closed_at"]) expect(FOLLOWUP_READ_COLUMNS).toContain(c);
    const src = readFileSync(join(process.cwd(), "lib/waitlist/followups-owner.ts"), "utf8");
    for (const c of FOLLOWUP_READ_COLUMNS) expect(src, c).toMatch(new RegExp(`r\\.${c}\\b`));
  });
});
