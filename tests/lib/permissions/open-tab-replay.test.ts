import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Roles R4 (OPS, 3 Nov; Codex at 48133681f): a server action is callable from an already-open tab after a key is revoked. Each action that
// RETURNS chart or intake data asks the key itself and, when refused, returns a refusal and issues no table read or rpc.

const { touched, allowed, asked } = vi.hoisted(() => ({
  touched: vi.fn(),
  allowed: { value: false },
  asked: vi.fn(),
}));

vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: vi.fn(async (_db: unknown, _studio: string, key: string) => {
    asked(key);
    return { allowed: allowed.value, mode: "enforce", engine: allowed.value };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (...a: unknown[]) => {
      touched("from", ...a);
      throw new Error("a table was read after the key was refused");
    },
    rpc: (...a: unknown[]) => {
      touched("rpc", ...a);
      throw new Error("an rpc ran after the key was refused");
    },
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p1", active: true },
    studio: { id: "studio1" },
  }),
}));
vi.mock("@/lib/sessions/session-lineage", () => ({
  assertSessionForClient: async () => undefined,
  SessionLineageError: class SessionLineageError extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));

beforeEach(() => {
  touched.mockClear();
  asked.mockClear();
  allowed.value = false;
});

const DIR = "@/app/(app)/clients/[id]/sessions/[sessionId]";

describe("open-tab replay after clin.view_records is revoked", () => {
  it("getWholeSessionCopySourceAction returns a refusal and reads nothing", async () => {
    const { getWholeSessionCopySourceAction } = await import(`${DIR}/whole-session-copy-actions`);
    const res = await getWholeSessionCopySourceAction({ clientId: "c1", sessionId: "s1" });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/source":\[/);
    expect(asked).toHaveBeenCalledWith("clin.view_records");
    expect(touched).not.toHaveBeenCalled();
  });

  it("createSessionBlockAction and updateSessionBlockAction return a refusal, no block", async () => {
    const m = await import(`${DIR}/block-actions`);
    const created = await m.createSessionBlockAction({ clientId: "c1", sessionId: "s1" } as never);
    const updated = await m.updateSessionBlockAction({ clientId: "c1", sessionId: "s1", blockId: "b1", patch: {} } as never);
    for (const r of [created, updated]) {
      expect(r.ok).toBe(false);
      expect("block" in r).toBe(false);
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it("createTreatmentAreaWithEntryAction refuses before writing and is not an unknown outcome", async () => {
    const m = await import(`${DIR}/block-actions`);
    const r = await m.createTreatmentAreaWithEntryAction({ clientId: "c1", sessionId: "s1" } as never);
    expect(r.ok).toBe(false);
    expect((r as { unresolved?: boolean }).unresolved).toBe(false);
    expect(touched).not.toHaveBeenCalled();
  });

  it("readingsForBlockAction fails closed with no readings", async () => {
    const m = await import(`${DIR}/machine-setup-actions`);
    const r = await m.readingsForBlockAction({ blockId: "b1", clientId: "c1", sessionId: "s1" });
    expect(r.ok).toBe(false);
    expect(touched).not.toHaveBeenCalled();
  });

  it("NQ-10: charting writes refuse too (void/remove block and area, whole-session copy commit)", async () => {
    const m = await import(`${DIR}/block-actions`);
    const reason = "a long enough reason";
    const r1 = await m.softDeleteSessionBlockAction({ clientId: "c1", sessionId: "s1", blockId: "b1", reason } as never);
    const r2 = await m.removeSessionAreaAction({ clientId: "c1", sessionId: "s1", blockId: "b1", reason } as never);
    const { commitWholeSessionCopyAction } = await import(`${DIR}/whole-session-copy-actions`);
    const r3 = await commitWholeSessionCopyAction({ clientId: "c1", sessionId: "s1", drafts: [], idempotencyKey: "k", sourceSessionId: null, sourceFingerprint: null });
    for (const r of [r1, r2, r3]) expect(r.ok).toBe(false);
    expect(touched).not.toHaveBeenCalled();
  });

  it("while the key is on, the same call proceeds past the gate (the refusal is the key, not an accident)", async () => {
    allowed.value = true;
    const { getWholeSessionCopySourceAction } = await import(`${DIR}/whole-session-copy-actions`);
    await getWholeSessionCopySourceAction({ clientId: "c1", sessionId: "s1" }).catch(() => undefined);
    expect(touched).toHaveBeenCalled();
  });
});

describe("open-tab replay after clin.view_intake is revoked", () => {
  it("getIntakeLinkAction asks clin.view_intake before it reads the intake row or builds a link", () => {
    const src = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");
    const start = src.indexOf("export async function getIntakeLinkAction");
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    const gate = body.search(/requirePermission\([\s\S]{0,120}?"clin\.view_intake"/);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf('.from("client_intake_forms")'));
    expect(body.slice(gate, gate + 250)).toMatch(/return \{ ok: false, error: INTAKE_NOT_AVAILABLE \}/);
  });

  it.each([
    ["handOffAssistedIntakeAction", "loadAssistedIntake(", "ASSISTED_NOT_PERMITTED"],
    ["startAssistedIntakeAction", '.from("client_intake_forms")', "START_NOT_PERMITTED"],
  ])("%s asks clin.view_intake before any intake read and refuses with its generic error", (name, firstRead, err) => {
    const src = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");
    const start = src.indexOf(`export async function ${name}`);
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    const gate = body.search(/requirePermission\([\s\S]{0,120}?"clin\.view_intake"/);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf(firstRead));
    expect(body.slice(gate, gate + 250)).toContain(`return { ok: false, error: ${err} }`);
  });
});

describe("NQ-10 (Insurance RV-1, Privacy AC1): editing requires viewing, whatever the action returns", () => {
  it("every treatment-plan write refuses without clin.view_records and touches nothing", async () => {
    const m = await import("@/app/(app)/clients/[id]/treatment-plans-actions");
    const fd = new FormData();
    fd.set("client_id", "c1");
    fd.set("plan_id", "p1");
    const names = ["createTreatmentPlanAction", "closeTreatmentPlanAction", "attachChartEntryToPlanAction", "detachChartEntryFromPlanAction", "updateTreatmentPlanNotesAction", "createTreatmentPlanStageAction", "updateTreatmentPlanStageAction", "deleteTreatmentPlanStageAction"] as const;
    for (const n of names) {
      const r = await (m[n] as (f: FormData) => Promise<{ ok: boolean }>)(fd);
      expect(r.ok, n).toBe(false);
    }
    expect(asked).toHaveBeenCalledWith("clin.view_records");
    expect(touched).not.toHaveBeenCalled();
  });

  it.each([
    ["app/(app)/clients/[id]/intake/actions.ts", "markIntakeReviewedAction", "clin.view_intake", 'from("client_intake_forms")'],
    ["app/(app)/clients/[id]/intake/actions.ts", "saveIntakeNotesAction", "clin.view_intake", 'from("client_intake_forms")'],
    ["app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", "updateSessionPerformerAction", "clin.view_records", 'rpc("set_session_performer"'],
  ])("%s %s asks %s before it reads or writes", (file, name, key, firstUse) => {
    const src = readFileSync(file, "utf8");
    const start = src.indexOf(`export async function ${name}`);
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    const gate = body.search(new RegExp(`requirePermission\\([\\s\\S]{0,120}?"${key.replace(".", "\\.")}"`));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf(firstUse));
  });

  it("updateSessionPriceAction is the documented residual: a pricing action, not gated on the records key", () => {
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", "utf8");
    const start = src.indexOf("export async function updateSessionPriceAction");
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    expect(body).not.toMatch(/clin\.view_records/);
  });
});
