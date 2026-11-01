import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyForCheck, type OpenAppointment, type PractitionerLite } from "@/lib/appointments/check-practitioner";

// Sam 1 Nov: the owner reviews OPEN appointments whose practitioner may be wrong (NULL, owner-assigned in a
// multi-practitioner studio, booker-assigned with a chart written by someone else). Nothing is changed
// automatically; each correction is an explicit, owner-only, audited command.

const OWNER = "p-owner", ANN = "p-ann", BEA = "p-bea";
const NOW = new Date("2031-01-01T12:00:00Z");
const team: PractitionerLite[] = [
  { id: OWNER, role: "owner", active: true, displayName: "Olive" },
  { id: ANN, role: "practitioner", active: true, displayName: "Ann" },
  { id: BEA, role: "practitioner", active: false, displayName: "Bea" },
];
const appt = (o: Partial<OpenAppointment> & { id: string }): OpenAppointment => ({
  startsAt: "2031-02-01T10:00:00Z", practitionerId: ANN, createdByPractitionerId: null, performedBy: [], ...o,
});

describe("classifyForCheck", () => {
  it("(a) a NULL practitioner is listed; a normally assigned one is not", () => {
    const out = classifyForCheck([appt({ id: "a1", practitionerId: null }), appt({ id: "a2" })], team, NOW);
    expect(out.map((i) => i.id)).toEqual(["a1"]);
    expect(out[0].reasons).toEqual(["no_practitioner"]);
  });
  it("(b) owner-assigned is listed only when the studio has more than one ACTIVE practitioner", () => {
    expect(classifyForCheck([appt({ id: "b1", practitionerId: OWNER })], team, NOW)[0].reasons).toEqual(["owner_default"]);
    const solo = [{ ...team[0] }, { ...team[1], active: false }, team[2]];
    expect(classifyForCheck([appt({ id: "b2", practitionerId: OWNER })], solo, NOW)).toEqual([]);
  });
  it("(c) booker-assigned where a linked session was performed by someone else; the performer is a SUGGESTION only", () => {
    const out = classifyForCheck(
      [appt({ id: "c1", practitionerId: OWNER, createdByPractitionerId: OWNER, performedBy: [ANN] })],
      team,
      NOW,
    );
    expect(out[0].reasons).toEqual(["owner_default", "booker_session_differs"]);
    expect(out[0].suggestionPractitionerId).toBe(ANN);
    expect(out[0].currentPractitionerId).toBe(OWNER); // never rewritten by classification
  });
  it("no session evidence, or the session was performed by the assignee: no booker flag and no suggestion", () => {
    const out = classifyForCheck(
      [appt({ id: "c2", practitionerId: ANN, createdByPractitionerId: ANN, performedBy: [ANN] }),
       appt({ id: "c3", practitionerId: ANN, createdByPractitionerId: ANN, performedBy: [] })],
      team, NOW);
    expect(out).toEqual([]);
  });
  it("an inactive performer is never suggested", () => {
    const out = classifyForCheck(
      [appt({ id: "c4", practitionerId: OWNER, createdByPractitionerId: OWNER, performedBy: [BEA] })], team, NOW);
    expect(out[0].suggestionPractitionerId).toBeNull();
  });
  it("splits future from started, sorted by time", () => {
    const out = classifyForCheck(
      [appt({ id: "f", practitionerId: null, startsAt: "2031-03-01T10:00:00Z" }),
       appt({ id: "p", practitionerId: null, startsAt: "2030-12-30T10:00:00Z" })], team, NOW);
    expect(out.map((i) => [i.id, i.isFuture])).toEqual([["p", false], ["f", true]]);
  });
});

const ctx = vi.hoisted(() => ({
  role: "owner" as string,
  appt: { id: "", status: "confirmed", starts_at: "", ends_at: "", practitioner_id: "p-owner" } as Record<string, unknown> | null,
  rpc: [] as Record<string, unknown>[],
  rpcResult: "reassigned",
  studioFilter: [] as unknown[],
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-owner", role: ctx.role, active: true },
    studio: { id: "studio-1" },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "eq") return (c: string, v: unknown) => { if (c === "studio_id") ctx.studioFilter.push(v); return chain; };
          if (prop === "maybeSingle") return async () => ({ data: ctx.appt, error: null });
          return () => chain;
        },
      });
      return chain;
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      ctx.rpc.push(args);
      return { data: [{ result: ctx.rpcResult }], error: null };
    },
  }),
}));

import { reassignOpenAppointmentAction } from "@/app/(app)/calendar/check-practitioner/actions";

const A = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const future = () => new Date(Date.now() + 5 * 864e5).toISOString();

beforeEach(() => {
  ctx.role = "owner"; ctx.rpc.length = 0; ctx.rpcResult = "reassigned"; ctx.studioFilter.length = 0;
  ctx.appt = { id: A, status: "confirmed", starts_at: future(), ends_at: future(), practitioner_id: "p-owner" };
});

describe("reassignOpenAppointmentAction", () => {
  it("owner, future open appointment: one command call, same time, the chosen target, no override", async () => {
    expect(await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }))).toEqual({ ok: true });
    expect(ctx.rpc).toHaveLength(1);
    expect(ctx.rpc[0]).toMatchObject({
      p_appointment_id: A, p_studio_id: "studio-1", p_actor_practitioner_id: "p-owner",
      p_target_practitioner_id: T1, p_allow_outside_availability: false,
    });
    expect(ctx.rpc[0].p_new_starts_at).toBe(ctx.rpc[0].p_expected_starts_at);
    expect(ctx.studioFilter).toEqual(["studio-1"]);
  });
  it("a practitioner is refused before any read or command", async () => {
    ctx.role = "practitioner";
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r.ok).toBe(false);
    expect(ctx.rpc).toEqual([]);
    expect(ctx.studioFilter).toEqual([]);
  });
  it("a started appointment is refused with a plain sentence and nothing is changed", async () => {
    ctx.appt = { id: A, status: "confirmed", starts_at: new Date(Date.now() - 36e5).toISOString(), ends_at: future(), practitioner_id: null };
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r).toEqual({ ok: false, error: "This appointment has already started. Changing its practitioner is not available yet." });
    expect(ctx.rpc).toEqual([]);
  });
  it("not found / other studio, a closed appointment, the same practitioner, and malformed ids are refused without a command", async () => {
    ctx.appt = null;
    expect((await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }))).ok).toBe(false);
    ctx.appt = { id: A, status: "completed", starts_at: future(), ends_at: future(), practitioner_id: null };
    expect((await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }))).ok).toBe(false);
    ctx.appt = { id: A, status: "confirmed", starts_at: future(), ends_at: future(), practitioner_id: T1 };
    expect((await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }))).ok).toBe(false);
    expect((await reassignOpenAppointmentAction(form({ appointment_id: "x", target_practitioner_id: "y" }))).ok).toBe(false);
    expect(ctx.rpc).toEqual([]);
  });
  it("the command's own refusals surface as plain sentences, never raw codes", async () => {
    ctx.rpcResult = "invalid_practitioner";
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r).toEqual({ ok: false, error: "That practitioner isn't available for this appointment." });
  });
});

describe("source contracts", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it("the page is owner-only and READ-ONLY: it calls no command and no write", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    expect(page).toContain('if (practitioner.role !== "owner") notFound();');
    expect(page).not.toMatch(/\.rpc\(|\.update\(|\.insert\(|\.delete\(|\.upsert\(|reassignOpenAppointmentAction/);
  });
  it("the suggestion only pre-selects a dropdown; only a submit calls the action", () => {
    const row = read("app/(app)/calendar/check-practitioner/ReassignRow.tsx");
    expect(row.match(/reassignOpenAppointmentAction\(/g)).toHaveLength(1);
    expect(row).toMatch(/onSubmit=\{\(e\) => \{[\s\S]*?reassignOpenAppointmentAction\(fd\)/);
    expect(row).not.toMatch(/useEffect/);
  });
  it("the action sends no client email and no payment write", () => {
    const act = read("app/(app)/calendar/check-practitioner/actions.ts");
    const code = act.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/email|sendMail|resend|settlement|charge|refund|payment/i);
    expect(code).not.toMatch(/\.from\("(?!appointments")/);
  });
});
