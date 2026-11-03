import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogByKey, enforcementOf } from "@/lib/permissions/catalog";
import { routineMessageAllowed } from "@/lib/permissions/routine-message";
import { resetEngineAbsentAlert, type PermissionDb } from "@/lib/permissions/require-permission";

const read = (p: string) => readFileSync(p, "utf8");
const dbAnswering = (data: unknown, error: unknown = null): PermissionDb => ({ rpc: async () => ({ data, error }) });

describe("R5 slice 1: routineMessageAllowed (comm.send_routine)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetEngineAbsentAlert();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("allowed: the message is sent and nothing is logged", async () => {
    expect(await routineMessageAllowed(dbAnswering(true), "studio-1", { appointment: "appt-1" })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it("denied: the message is withheld, one id-only event is logged", async () => {
    expect(await routineMessageAllowed(dbAnswering(false), "studio-1", { appointment: "appt-1" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(line).toMatchObject({ event: "routine_message_withheld_by_permission", key: "comm.send_routine", appointmentId: "appt-1" });
    expect(Object.keys(line).sort()).toEqual(["appointmentId", "event", "key", "timestamp"]); // no recipient, no content
  });
  it("fails CLOSED when the engine answers oddly or errors (present but unreadable)", async () => {
    expect(await routineMessageAllowed(dbAnswering(null), "s")).toBe(false);
    expect(await routineMessageAllowed(dbAnswering(null, { code: "XX000", message: "boom" }), "s")).toBe(false);
    expect(await routineMessageAllowed({ rpc: async () => { throw new Error("net"); } }, "s")).toBe(false);
  });
  it("engine absent (0287 not applied yet): allowed, the legacy checks stand", async () => {
    expect(await routineMessageAllowed(dbAnswering(null, { code: "PGRST202", message: "x" }), "s")).toBe(true);
  });
  it("asks the comm.send_routine key with the appointment context and nothing else", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await routineMessageAllowed({ rpc } as unknown as PermissionDb, "studio-9", { appointment: "appt-9" });
    expect(rpc).toHaveBeenCalledWith("has_studio_permission", { p_studio: "studio-9", p_key: "comm.send_routine", p_client: null, p_appointment: "appt-9", p_practitioner: null });
  });
});

describe("R5 slice 1: wiring", () => {
  const FIRST_EFFECT = /\.from\("clients"\)|\.insert\(|createAdminClient\(\)|\.rpc\(/;

  it("both client-creation actions ask client.create before the insert", () => {
    for (const [file, fn] of [
      ["app/(app)/clients/new/actions.ts", "createClientAction"],
      ["app/(app)/calendar/actions.ts", "createClientForCalendarBookingAction"],
    ] as const) {
      const src = read(file);
      const start = src.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport async function ", start + 10);
      const body = src.slice(start, next === -1 ? undefined : next);
      const ask = body.indexOf('"client.create"');
      expect(ask, `${fn} asks client.create`).toBeGreaterThan(-1);
      expect(body.lastIndexOf("requirePermission(", ask)).toBeGreaterThan(-1);
      expect(ask, `${fn} asks before its first effect`).toBeLessThan(body.search(FIRST_EFFECT));
      expect(body.slice(ask, ask + 260)).toMatch(/permission to add clients/);
    }
  });

  it("the booking confirmation dispatch returns before any send when comm.send_routine is denied", () => {
    const src = read("app/(app)/calendar/actions.ts");
    const start = src.indexOf("async function dispatchBookingEmails(");
    const body = src.slice(start, src.indexOf("\nexport async function ", start));
    const ask = body.indexOf("routineMessageAllowed(");
    expect(ask).toBeGreaterThan(-1);
    expect(body.slice(ask, ask + 200)).toMatch(/\)\) return;/);
    for (const send of ["sendBookingConfirmationToClient(", "sendBookingConfirmationSmsToClient(", "sendBookingNotificationToPractitioner(", "ensureIntakeForClient("]) {
      expect(ask, send).toBeLessThan(body.indexOf(send));
    }
  });

  it("the cancellation email is gated; the cancellation itself is not", () => {
    const src = read("app/(app)/calendar/actions.ts");
    const start = src.indexOf("export async function cancelAppointmentAction(");
    const body = src.slice(start, src.indexOf("\nexport async function ", start + 10));
    expect(body).toMatch(/client\?\.email && \(await routineMessageAllowed\(supabase, studio\.id, \{ appointment: appointmentId \}\)\)/);
    expect(body.indexOf('"appt.cancel"')).toBeLessThan(body.indexOf("routineMessageAllowed("));
  });

  it("a denied move still moves and reports the client message as skipped", () => {
    const src = read("app/(app)/calendar/move-appointment-actions.ts");
    const at = src.indexOf("const notificationStatus");
    const stmt = src.slice(at, at + 520);
    expect(stmt).toContain("routineMessageAllowed(userDb");
    expect(stmt).toMatch(/\? await notifyAppointmentMoved\(/);
    expect(stmt).toMatch(/: "skipped"/);
    expect(at).toBeGreaterThan(src.indexOf("move_or_reassign_appointment"));
  });

  it("the two keys are marked enforced; client.edit_contact is deliberately NOT (its audit needs the held 0290 DB command)", () => {
    expect(enforcementOf("client.create")).toBe("enforced");
    expect(enforcementOf("comm.send_routine")).toBe("enforced");
    expect(enforcementOf("client.edit_contact")).toBe("not_yet");
    expect(catalogByKey.get("client.edit_contact")?.description).toMatch(/audited with masked/);
    expect(read("app/(app)/clients/[id]/actions.ts")).not.toContain('"client.edit_contact"');
  });

  it("client.create is 'enforced', not 'deny_only': no role check stands in front of the key, so widening it takes effect", () => {
    const src = read("app/(app)/clients/new/actions.ts");
    const start = src.indexOf("export async function createClientAction(");
    const body = src.slice(start, src.indexOf('"client.create"', start));
    expect(body).not.toMatch(/\.role\b/); // no owner/practitioner floor before the key
    const quick = read("app/(app)/calendar/actions.ts");
    const qs = quick.indexOf("export async function createClientForCalendarBookingAction(");
    expect(quick.slice(qs, quick.indexOf('"client.create"', qs))).not.toMatch(/\.role\b/);
    // and the database does not close the path to a member either: the insert policy is studio-membership only
    const policy = read("supabase/migrations/0087_clinical_rls_delete_hardening.sql");
    expect(policy).toMatch(/create policy "clients: members insert"\s+on public\.clients for insert to authenticated\s+with check \(public\.is_studio_member\(studio_id\)\)/);
  });

  it("comm.send_routine has no legacy floor of its own: it sits behind each action's own key, and the cancel path is open to any role that holds appt.cancel", () => {
    const src = read("app/(app)/calendar/actions.ts");
    const start = src.indexOf("export async function cancelAppointmentAction(");
    const body = src.slice(start, src.indexOf("\nexport async function ", start + 10));
    expect(body).not.toMatch(/practitioner\.role !== "owner"/); // cancel is not owner-only, so the message key is reachable
    expect(enforcementOf("appt.cancel")).toBe("enforced");
  });
});
