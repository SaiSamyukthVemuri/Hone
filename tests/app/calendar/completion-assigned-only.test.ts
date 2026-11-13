import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canCompleteAppointment } from "@/lib/appointments/completion-authority";

// Sam decision 3 (1 Nov): a practitioner completes ONLY an appointment assigned to them; an owner
// any appointment in their studio; completion never touches payment; a receptionist has no path.

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const OWNER = { id: "p-owner", role: "owner", active: true };
const PRACT = { id: "p-mine", role: "practitioner", active: true };
const OTHER = "p-other";

const rows: Record<string, { studio_id: string; practitioner_id: string | null }> = {
  "appt-mine": { studio_id: STUDIO_A, practitioner_id: PRACT.id },
  "appt-other": { studio_id: STUDIO_A, practitioner_id: OTHER },
  "appt-unassigned": { studio_id: STUDIO_A, practitioner_id: null },
  "appt-studio-b": { studio_id: STUDIO_B, practitioner_id: PRACT.id },
};

let actor: typeof OWNER | typeof PRACT = PRACT;
let identityThrows = false;
const tablesRead: string[] = [];
const rpcCalls: string[] = [];
const rpcArgs: Record<string, unknown>[] = [];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    if (identityThrows) throw new Error("no practitioner row");
    return { practitioner: actor, studio: { id: STUDIO_A } };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      tablesRead.push(table);
      const f: Record<string, unknown> = {};
      const chain: Record<string, unknown> = new Proxy(f, {
        get(_t, prop: string) {
          if (prop === "eq") return (col: string, val: unknown) => { f[col] = val; return chain; };
          if (prop === "select") return () => chain;
          if (prop === "maybeSingle") {
            return async () => {
              const row = rows[f.id as string];
              // RLS + the studio filter: a row outside the caller's studio is simply not returned.
              if (!row || row.studio_id !== f.studio_id) return { data: null, error: null };
              return { data: { practitioner_id: row.practitioner_id }, error: null };
            };
          }
          return () => chain;
        },
      });
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push(name);
      rpcArgs.push(args ?? {});
      return { error: null };
    },
  }),
}));
vi.mock("@/app/(app)/calendar/postcare-auto-send", () => ({ autoSendPostcareOnComplete: vi.fn() }));

async function complete(id: string, extra: Record<string, string> = {}) {
  const { markAppointmentCompleteAction } = await import("@/app/(app)/calendar/actions");
  const fd = new FormData();
  fd.set("appointment_id", id);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return markAppointmentCompleteAction(fd);
}

beforeEach(() => {
  actor = PRACT;
  identityThrows = false;
  tablesRead.length = 0;
  rpcCalls.length = 0;
  rpcArgs.length = 0;
});

describe("canCompleteAppointment", () => {
  it("owner: any appointment, assigned or not", () => {
    expect(canCompleteAppointment(OWNER, OTHER)).toBe(true);
    expect(canCompleteAppointment(OWNER, null)).toBe(true);
  });
  it("practitioner: only their own", () => {
    expect(canCompleteAppointment(PRACT, PRACT.id)).toBe(true);
    expect(canCompleteAppointment(PRACT, OTHER)).toBe(false);
    expect(canCompleteAppointment(PRACT, null)).toBe(false);
    expect(canCompleteAppointment(PRACT, undefined)).toBe(false);
  });
  it("any other role has no path", () => {
    for (const role of ["receptionist", "", null, undefined, "admin"]) {
      expect(canCompleteAppointment({ id: PRACT.id, role }, PRACT.id)).toBe(false);
    }
  });
});

describe("markAppointmentCompleteAction enforces assignment", () => {
  it("assigned practitioner: completes", async () => {
    expect(await complete("appt-mine")).toEqual({ ok: true });
    expect(rpcCalls).toEqual(["mark_appointment_complete"]);
  });
  it("practitioner, appointment assigned to someone else: refused, command never called", async () => {
    const res = await complete("appt-other");
    expect(res).toEqual({
      ok: false,
      error: "Only the practitioner assigned to this appointment, or the studio owner, can mark it complete.",
    });
    expect(rpcCalls).toEqual([]);
  });
  it("practitioner, unassigned appointment: refused", async () => {
    expect((await complete("appt-unassigned")).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it("practitioner, other studio's appointment: refused with the SAME answer as 'someone else's'", async () => {
    const cross = await complete("appt-studio-b");
    const other = await complete("appt-other");
    expect(cross).toEqual(other);
    const missing = await complete("appt-does-not-exist");
    expect(missing).toEqual(other);
    expect(rpcCalls).toEqual([]);
  });
  it("owner: completes any appointment in the studio (assigned elsewhere or unassigned)", async () => {
    actor = OWNER;
    expect((await complete("appt-other")).ok).toBe(true);
    expect((await complete("appt-unassigned")).ok).toBe(true);
    expect(rpcCalls).toHaveLength(2);
  });
  it("owner, other studio's appointment: refused", async () => {
    actor = OWNER;
    expect((await complete("appt-studio-b")).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it("a receptionist (no practitioner row) has no path: identity fails, no read, no command", async () => {
    identityThrows = true;
    await expect(complete("appt-mine")).rejects.toThrow();
    expect(tablesRead).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
  it("the completion path reads no payment table, only the appointment's assignment", async () => {
    await complete("appt-mine");
    expect(tablesRead).toEqual(["appointments"]);
    expect(rpcCalls).not.toContain("record_appointment_settlement");
  });
});

describe("session start is not a way around the rule (source pin)", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/clients/[id]/sessions/new/actions.ts"),
    "utf8",
  );
  it("auto-complete asks the same helper, with the appointment's assignee and the caller's role", () => {
    expect(SRC).toContain('from "@/lib/appointments/completion-authority"');
    expect(SRC).toMatch(/canCompleteAppointment\(\{ id: args\.practitionerId, role: args\.role \}, args\.assignedPractitionerId\)/);
    expect(SRC).toContain("assignedPractitionerId: appointmentAssignedTo");
    expect(SRC).toContain("role: practitioner.role");
  });
});

describe("the completion control is hidden from a practitioner who cannot use it (a hint; the action above is the gate)", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  const CAL_PAGE = read("app/(app)/calendar/[id]/page.tsx");
  const LIFECYCLE = read("app/(app)/calendar/AppointmentLifecycleActions.tsx");
  const SESSION_PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");

  it("the calendar page computes it from the appointment's assignee and passes it down", () => {
    expect(CAL_PAGE).toContain("canComplete={canCompleteAppointment(practitioner, data.practitioner_id)}");
  });
  it("the lifecycle component renders the shared control only when canComplete, else an explanation", () => {
    expect(LIFECYCLE).toMatch(/canComplete \? \(\s*<MarkAppointmentCompleteControl/);
    expect(LIFECYCLE).toContain('data-testid="completion-not-assigned"');
  });
  it("the session page reads the assignee in its ONE appointment read and gates the control on it", () => {
    expect(SESSION_PAGE).toContain("postcare_email_send_attempts, practitioner_id, service:services(");
    expect(SESSION_PAGE).toContain("assignedPractitionerId: (row.practitioner_id as string | null) ?? null");
    expect(SESSION_PAGE).toMatch(/canCompleteAppointment\(practitioner, apptContext\?\.assignedPractitionerId\) && \(\s*<MarkAppointmentCompleteControl/);
    expect(SESSION_PAGE).toContain('data-testid="completion-not-assigned"');
  });
  it("the server action's refusal is still there (the hint never replaces it)", () => {
    const ACTIONS = read("app/(app)/calendar/actions.ts");
    expect(ACTIONS).toContain("canCompleteAppointment(practitioner, assignment.practitioner_id)");
  });
});

// Privacy C1: the database enforces assignment for the practitioner id it is GIVEN, so the id must
// come from the signed-in session on every caller and never from a request value.
describe("the practitioner id passed to the completion command is the session's", () => {
  it("calendar action: hostile practitioner fields in the form are ignored", async () => {
    // the colleague's id is in the request; the command still receives the session's own id
    const res = await complete("appt-other", { practitioner_id: OTHER, actor_id: OTHER, p_practitioner_id: OTHER });
    expect(res.ok).toBe(false); // still refused: the assignment check uses the SESSION actor
    expect(rpcCalls).toEqual([]);
    const ok = await complete("appt-mine", { practitioner_id: OTHER, actor_id: OTHER, p_practitioner_id: OTHER });
    expect(ok.ok).toBe(true);
    expect(rpcArgs[0]).toMatchObject({ p_practitioner_id: PRACT.id, p_studio_id: STUDIO_A });
  });
  it("an owner's request naming the assignee still records the owner as the completer", async () => {
    actor = OWNER;
    await complete("appt-other", { practitioner_id: OTHER });
    expect(rpcArgs[0]).toMatchObject({ p_practitioner_id: OWNER.id });
  });
  it("session-start caller: derives practitionerId from the session, not from formData", () => {
    const SRC = readFileSync(
      path.resolve(__dirname, "../../..", "app/(app)/clients/[id]/sessions/new/actions.ts"),
      "utf8",
    );
    expect(SRC).toContain("practitionerId: practitioner.id,");
    const at = SRC.indexOf('admin.rpc("mark_appointment_complete"');
    expect(at).toBeGreaterThan(0);
    const helper = SRC.slice(SRC.lastIndexOf("function maybeMarkAppointmentCompletedOnSessionStart", at), at + 300);
    expect(helper).not.toMatch(/formData|FormData/);
    expect(helper).toContain("p_practitioner_id: args.practitionerId");
  });
  it("neither caller takes the id from a request value", () => {
    const CAL = readFileSync(path.resolve(__dirname, "../../..", "app/(app)/calendar/actions.ts"), "utf8");
    const i = CAL.indexOf('admin.rpc("mark_appointment_complete"');
    expect(CAL.slice(i, i + 250)).toContain("p_practitioner_id: practitioner.id");
  });
});
