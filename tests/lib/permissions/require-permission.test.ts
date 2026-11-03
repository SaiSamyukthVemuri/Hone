import { describe, expect, it, vi } from "vitest";
import { permissionMode, requirePermission, type PermissionDb } from "@/lib/permissions/require-permission";

const db = (data: unknown, error: unknown = null): PermissionDb & { rpc: ReturnType<typeof vi.fn> } => ({
  rpc: vi.fn(async () => ({ data, error })),
}) as never;

describe("requirePermission", () => {
  it("modes follow the catalog: source-backed and new keys enforce, the unenforced approved policy only observes", () => {
    for (const k of ["appt.book", "appt.move", "appt.reassign", "appt.handoff_own"]) expect(permissionMode(k), k).toBe("enforce");
    expect(permissionMode("appt.complete")).toBe("observe");
    expect(permissionMode("no.such.key")).toBe("enforce");
  });

  it("passes the studio, key and ids to has_studio_permission and honours the engine answer (ON / OFF)", async () => {
    const on = db(true);
    expect(await requirePermission(on, "S", "appt.move", { appointment: "A" })).toMatchObject({ allowed: true, engine: true });
    expect(on.rpc).toHaveBeenCalledWith("has_studio_permission", { p_studio: "S", p_key: "appt.move", p_client: null, p_appointment: "A", p_practitioner: null });
    expect(await requirePermission(db(false), "S", "appt.move", { appointment: "A" })).toMatchObject({ allowed: false, engine: false });
  });

  it("own versus colleague: the engine decides from the appointment id, the helper never infers it", async () => {
    const own = db(true), colleague = db(false);
    expect((await requirePermission(own, "S", "appt.move", { appointment: "mine" })).allowed).toBe(true);
    expect((await requirePermission(colleague, "S", "appt.move", { appointment: "theirs" })).allowed).toBe(false);
    expect((await requirePermission(colleague, "S", "appt.handoff_own", { appointment: "theirs" })).allowed).toBe(false);
  });

  it("enforce fails CLOSED on an error, a non-boolean or a throw", async () => {
    expect((await requirePermission(db(null, { code: "x" }), "S", "appt.book")).allowed).toBe(false);
    expect((await requirePermission(db("yes"), "S", "appt.book")).allowed).toBe(false);
    const boom = { rpc: vi.fn(async () => { throw new Error("down"); }) } as never;
    expect((await requirePermission(boom, "S", "appt.reassign")).allowed).toBe(false);
  });

  it("observe never blocks and logs the would-deny with ids only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await requirePermission(db(false), "S", "appt.complete", { appointment: "A" });
    expect(d).toMatchObject({ allowed: true, mode: "observe", engine: false });
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toMatchObject({ event: "permission_observe_would_deny", key: "appt.complete", appointmentId: "A" });
    expect(Object.keys(line).sort()).toEqual(["appointmentId", "engine", "event", "key", "timestamp"]);
    expect((await requirePermission(db(null, { code: "x" }), "S", "appt.complete")).allowed).toBe(true);
    warn.mockRestore();
  });
});
