import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyForCheck, practitionerLabel, type OpenAppointment, type PractitionerLite } from "@/lib/appointments/check-practitioner";

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
  target: { id: "", active: true } as Record<string, unknown> | null,
  targetStudio: [] as unknown[],
  sessionCount: 0,
  sessionErr: null as unknown,
  sessionFilters: [] as unknown[][],
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
    from: (table: string) => {
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then" && table === "sessions") {
            return (resolve: (v: unknown) => void) => resolve({ count: ctx.sessionCount, error: ctx.sessionErr });
          }
          if (prop === "eq" && table === "sessions") return (c: string, v: unknown) => { ctx.sessionFilters.push([c, v]); return chain; };
          if (prop === "eq") return (c: string, v: unknown) => { if (c === "studio_id") (table === "practitioners" ? ctx.targetStudio : ctx.studioFilter).push(v); return chain; };
          if (prop === "maybeSingle") return async () => ({ data: table === "practitioners" ? ctx.target : ctx.appt, error: null });
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
  ctx.role = "owner"; ctx.rpc.length = 0; ctx.rpcResult = "reassigned"; ctx.studioFilter.length = 0; ctx.targetStudio.length = 0; ctx.target = { id: T1, active: true }; ctx.sessionCount = 0; ctx.sessionErr = null; ctx.sessionFilters.length = 0;
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
    expect(r).toEqual({ ok: false, error: "This appointment's date has passed, so its practitioner is not changed here. Refresh the page to see its current state, or open the appointment to complete it." });
    expect(ctx.rpc).toEqual([]);
  });
  it("a FUTURE appointment that already has a live treatment record is refused server-side (stale tab or hand-made request); the read is studio-scoped", async () => {
    ctx.sessionCount = 1;
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("treatment record now exists");
    expect(ctx.rpc).toEqual([]);
    expect(ctx.sessionFilters).toEqual([["appointment_id", A], ["studio_id", "studio-1"]]);
  });
  it("fails closed when the treatment-record read errors", async () => {
    ctx.sessionErr = { code: "XX000" };
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r.ok).toBe(false);
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
  it("a target that is inactive, missing or in another studio is refused on the server before any command (Codex P2)", async () => {
    ctx.target = { id: T1, active: false };
    const r = await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }));
    expect(r).toEqual({ ok: false, error: "That practitioner isn't available for this appointment." });
    ctx.target = null;
    expect((await reassignOpenAppointmentAction(form({ appointment_id: A, target_practitioner_id: T1 }))).ok).toBe(false);
    expect(ctx.rpc).toEqual([]);
    expect(ctx.targetStudio.every((v) => v === "studio-1")).toBe(true);
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
  it("soft-deleted sessions are not used as reassignment evidence (Codex P2)", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    expect(page).toContain("sessions(performed_by_practitioner_id, started_at, deleted_at)");
    expect(page).toMatch(/\.filter\(\(s\) => s\.deleted_at === null \|\| s\.deleted_at === undefined\)/);
  });
  it("every open appointment is read in pages and an incomplete read never claims 'Nothing to check' (Codex P2)", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    expect(page).not.toMatch(/\.limit\(/);
    expect(page).toContain(".range(page * PAGE, page * PAGE + PAGE - 1)");
    expect(page).toContain('.order("starts_at")');
    expect(page).toContain('.order("id")');
    expect(page).toContain("MAX_PAGES");
    expect(page).toContain("if (got.length < PAGE) { complete = true; break; }");
    expect(page).toContain("check-practitioner-partial");
    expect(page).toMatch(/complete\s*\?\s*"Nothing to check/);
  });
  it("the suggestion only pre-selects a dropdown; only a submit calls the action", () => {
    const row = read("app/(app)/calendar/check-practitioner/ReassignRow.tsx");
    expect(row.match(/reassignOpenAppointmentAction\(/g)).toHaveLength(1);
    expect(row).toMatch(/onSubmit=\{\(e\) => \{[\s\S]*?reassignOpenAppointmentAction\(fd\)/);
    expect(row).not.toMatch(/useEffect/);
  });
  it("the list read tolerates a database without clients.preferred_name (pre-0258 chain), as the other surfaces do", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    expect(page).toContain("readWithPreferredName");
    expect(page).toContain("preferredNameColumn(withPreferred)");
    // the select never names preferred_name literally (that is what failed on a chain that lacks the column)
    expect(page).not.toMatch(/clients\(name, preferred_name\)/);
  });
  it("only an upcoming row has a reassign control; a past row says what is permitted and links to the appointment (Sam, 2 Nov)", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    const row = read("app/(app)/calendar/check-practitioner/ReassignRow.tsx");
    expect(page).toMatch(/it\.phase === "upcoming" \? \(\s*<ReassignRow/);
    expect(page).toContain("check-practitioner-historical");
    expect(page).toContain("The practitioner is not changed here.");
    expect(page).toContain("href={`/calendar/${it.id}`}");
    expect(row).not.toContain("canChange");
    expect(row).not.toContain("already started");
  });
  it("no wording on the page, the row or the action claims a past date means the treatment started", () => {
    for (const f of ["page.tsx", "ReassignRow.tsx", "actions.ts"]) {
      expect(read(`app/(app)/calendar/check-practitioner/${f}`)).not.toMatch(/already started/i);
    }
  });
  it("the review page and its action stay OWNER-ONLY by explicit server checks, independent of any future configurable reassign permission", () => {
    expect(read("app/(app)/calendar/check-practitioner/page.tsx")).toMatch(/practitioner\.role !== "owner"\) notFound\(\)/);
    expect(read("app/(app)/calendar/check-practitioner/actions.ts")).toMatch(/practitioner\.role !== "owner"/);
  });
  it("the action sends no client email and no payment write", () => {
    const act = read("app/(app)/calendar/check-practitioner/actions.ts");
    const code = act.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/email|sendMail|resend|settlement|charge|refund|payment/i);
    // reads only: the appointment, its live linked sessions (a treatment record refuses the change), and the target
    // practitioner's active/studio membership; no other table
    expect(code).not.toMatch(/\.from\("(?!appointments"|practitioners"|sessions")/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

describe("phase: a past DATE is not a recorded treatment start (Sam, 2 Nov)", () => {
  const past = "2030-12-01T10:00:00Z"; // before NOW
  it("a future appointment is upcoming and reassignable", () => {
    const [it] = classifyForCheck([appt({ id: "u1", practitionerId: null })], team, NOW);
    expect(it.phase).toBe("upcoming");
    expect(it.isFuture).toBe(true);
  });
  it("a past appointment with NO linked session is date_passed, never described as started", () => {
    const [it] = classifyForCheck([appt({ id: "d1", startsAt: past, practitionerId: null })], team, NOW);
    expect(it.phase).toBe("date_passed");
    expect(it.treatmentStartedAt).toBeNull();
  });
  it("a past appointment WITH a linked session is treatment_recorded and carries the earliest recorded start", () => {
    const [it] = classifyForCheck(
      [appt({ id: "t1", startsAt: past, practitionerId: OWNER, linkedSessionCount: 1, treatmentStartedAt: "2030-12-01T10:05:00Z", performedBy: [ANN] })],
      team, NOW);
    expect(it.phase).toBe("treatment_recorded");
    expect(it.treatmentStartedAt).toBe("2030-12-01T10:05:00Z");
    expect(it.performedBy).toEqual([ANN]);
  });
  it("a future appointment that already has a linked session is treatment_recorded, not upcoming (the session decides, not the date)", () => {
    const [it] = classifyForCheck([appt({ id: "f1", practitionerId: OWNER, linkedSessionCount: 1 })], team, NOW);
    expect(it.phase).toBe("treatment_recorded");
    expect(it.isFuture).toBe(true);
  });
  it("sorting is unchanged: earliest first across phases", () => {
    const out = classifyForCheck([appt({ id: "x2", practitionerId: null }), appt({ id: "x1", startsAt: past, practitionerId: null })], team, NOW);
    expect(out.map((i) => i.id)).toEqual(["x1", "x2"]);
  });
});

describe("practitionerLabel: display name where available, email secondary", () => {
  it("a real name wins and the email is kept as the secondary line", () => {
    expect(practitionerLabel({ displayName: " Ann Lee ", email: "ann@example.test" })).toEqual({ name: "Ann Lee", email: "ann@example.test" });
  });
  it("a blank or generic name falls back to the email as the primary label", () => {
    expect(practitionerLabel({ displayName: "", email: "x@example.test" })).toEqual({ name: "x@example.test", email: null });
    expect(practitionerLabel({ displayName: "Practitioner", email: "y@example.test" })).toEqual({ name: "y@example.test", email: null });
  });
  it("neither name nor email gives a neutral word, never an empty string", () => {
    expect(practitionerLabel({ displayName: null, email: null })).toEqual({ name: "Practitioner", email: null });
  });
});

describe("navigation: an owner-only link, hidden for others, and independent of any new storage", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it("the calendar toolbar renders the link only when an href is given, and every view gives it only to the owner", () => {
    const bar = read("app/(app)/calendar/CalendarToolbar.tsx");
    expect(bar).toMatch(/\{reviewAssignmentsHref && \(/);
    expect(bar).toContain("Review practitioner assignments");
    const page = read("app/(app)/calendar/page.tsx");
    // one owner-only computation, passed to all three views; a non-owner gets undefined and never runs the read
    expect(page).toMatch(/const reviewAssignmentsHref =\s*isOwner && \(await shouldShowReviewLink\(studio\.id\)\) \? "\/calendar\/check-practitioner" : undefined/);
    expect(page.match(/reviewAssignmentsHref=\{reviewAssignmentsHref\}/g) ?? []).toHaveLength(3);
    expect(page).not.toMatch(/reviewAssignmentsHref=\{[^}]*"\/calendar\/check-practitioner"/);
  });
  it("Team settings (an owner-only page) links to it", () => {
    const team = read("app/(app)/settings/team/page.tsx");
    expect(team).toContain('href="/calendar/check-practitioner"');
    expect(team).toMatch(/showReviewLink \? \(/); // DQ-7: the reminder is conditional; a quiet entry stands in when it is hidden (tests/app/settings/team-review-entry.test.ts)
    expect(team).toContain("Review practitioner assignments");
  });
  it("the page still 404s for a non-owner and reads no table that needs new storage", () => {
    const page = read("app/(app)/calendar/check-practitioner/page.tsx");
    expect(page).toContain('if (practitioner.role !== "owner") notFound();');
    expect(page).not.toMatch(/appointment_assignment_reviews|review_appointment_assignment/);
  });
});
