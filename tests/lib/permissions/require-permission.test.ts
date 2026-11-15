import { describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: sentry.captureMessage }));

import { isEngineAbsent, permissionMode, requirePermission, resetEngineAbsentAlert, type PermissionDb } from "@/lib/permissions/require-permission";

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

  describe("release order: the engine (0287) may not be installed yet (Privacy X1)", () => {
    const absent = (code = "42883") => db(null, { code, message: "function public.has_studio_permission(uuid, text, uuid, uuid, uuid) does not exist" });

    it("absent engine: allow so the legacy checks stand, in BOTH modes, and alert the operator exactly once", async () => {
      resetEngineAbsentAlert();
      sentry.captureMessage.mockClear();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const key of ["appt.book", "clin.view_photos", "appt.complete"]) {
        expect(await requirePermission(absent(), "S", key), key).toMatchObject({ allowed: true, engineAbsent: true, engine: null });
      }
      expect(await requirePermission(absent("PGRST202"), "S", "appt.cancel")).toMatchObject({ allowed: true, engineAbsent: true });
      const alerts = err.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === "permission_engine_absent");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ ops_alert: true });
      expect(JSON.stringify(alerts[0])).not.toMatch(/"S"|client|email/);
      // Y1: one durable Sentry event per process, closed tags only, no ids
      expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
      const [msg, opts] = sentry.captureMessage.mock.calls[0]!;
      expect(msg).toBe("permission_engine_absent");
      expect(opts).toEqual({ level: "error", tags: { area: "permissions", reason: "engine_absent" }, fingerprint: ["permission_engine_absent"] });
      expect(JSON.stringify(opts)).not.toMatch(/"S"|studio|client|appointment|user|email/i);
      err.mockRestore();
    });

    it("present engine: enforcement is active, so a no is a refusal and any other failure still fails closed", async () => {
      resetEngineAbsentAlert();
      sentry.captureMessage.mockClear();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await requirePermission(db(false), "S", "appt.book")).toMatchObject({ allowed: false });
      expect(await requirePermission(db(true), "S", "appt.book")).toMatchObject({ allowed: true });
      expect(await requirePermission(db(null, { code: "57014", message: "timeout" }), "S", "appt.book")).toMatchObject({ allowed: false });
      expect(await requirePermission(db(null, { code: "42501", message: "permission denied for function has_studio_permission" }), "S", "appt.book")).toMatchObject({ allowed: false });
      expect(err.mock.calls.filter((c) => String(c[0]).includes("permission_engine_absent"))).toHaveLength(0);
      expect(sentry.captureMessage).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it("only a missing has_studio_permission counts as absent", () => {
      expect(isEngineAbsent({ code: "42883", message: "function public.has_studio_permission(uuid) does not exist" })).toBe(true);
      expect(isEngineAbsent({ code: "42883", message: "function public.perm_actor(uuid) does not exist" })).toBe(false); // partial apply fails closed
      expect(isEngineAbsent({ code: "PGRST202" })).toBe(true);
      expect(isEngineAbsent({ code: "42501" })).toBe(false);
      expect(isEngineAbsent({ message: "boom" })).toBe(false);
      expect(isEngineAbsent(null)).toBe(false);
    });
  });
});
