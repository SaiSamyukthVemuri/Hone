import { beforeEach, describe, expect, it, vi } from "vitest";

// THE ROLLOUT, ASKED AGAIN WHEN A NEW AREA IS CREATED (Codex PRRT_kwDOSfSOys65vx7Z). A form opened while the xCell unit was offered can
// submit after the rollout was switched Off. Both create routes that carry a unit (the identity-only save and the save with settings)
// re-read the rollout before anything is sent. Synthetic ids only.

const rpc = vi.fn();
const ROLLOUT = vi.hoisted(() => ({ value: "on" as "on" | "off" | "error", reads: 0 }));
const UNIT = vi.hoisted(() => ({ profileId: "dectro-apilus:xcell-pur" }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => rpc(name, args),
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/supabase/writing-identity", () => ({
  resolveWritingIdentity: async () => ({ ok: true, value: { practitioner: { id: "prac-1", active: true }, studio: { id: "studio-1" } } }),
}));
vi.mock("@/lib/sessions/session-lineage", () => ({ assertSessionForClient: async () => {}, SessionLineageError: class extends Error {} }));
vi.mock("@/lib/machines/studio-devices", () => ({
  listStudioDevices: async () => ({
    source: "table",
    devices: [
      { deviceId: "unit-1", studioId: "studio-1", profileId: UNIT.profileId, profileVersion: 1, displayName: "Room 1", installedOptions: [], retiredAt: null },
    ],
  }),
}));
vi.mock("@/lib/rollouts/charting-rollout", async (orig) => {
  const real = await orig<typeof import("@/lib/rollouts/charting-rollout")>();
  return { ...real, readChartingRollout: async () => { ROLLOUT.reads += 1; return ROLLOUT.value; } };
});

const { createTreatmentAreaWithEntryAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");
const { XCELL_ROLLOUT_OFF_MESSAGE, ROLLOUT_UNAVAILABLE_MESSAGE_SAVE } = await import("@/lib/machines/xcell-rollout-guard");

const BASE = { clientId: "c1", sessionId: "s1", mode: "thermo", createKey: "create-key-0001" };
const IDENTITY_ONLY = { ...BASE, machineIdentity: { machineId: "unit-1", modeKey: "multiplex", profileId: null } };
const WITH_SETUP = {
  ...BASE,
  initialSetup: {
    machineId: "unit-1",
    modeKey: "multiplex",
    idempotencyKey: "setup-key-0001",
    groups: [{ groupKey: null, newGroupRef: "n1", channels: [1], readings: [] }],
  },
};
const ROUTES = [
  ["the identity-only save", IDENTITY_ONLY],
  ["the save with settings", WITH_SETUP],
] as const;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: { message: "stop here" } });
  ROLLOUT.value = "on";
  ROLLOUT.reads = 0;
  UNIT.profileId = "dectro-apilus:xcell-pur";
});

describe("a NEW area with the xCell unit re-reads the rollout before anything is sent", () => {
  for (const [name, input] of ROUTES) {
    describe(name, () => {
      it("Off: refused with the plain message, definitively, and nothing is sent", async () => {
        ROLLOUT.value = "off";
        const out = await createTreatmentAreaWithEntryAction(input as never);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error).toBe(XCELL_ROLLOUT_OFF_MESSAGE);
        expect(out.unresolved).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
      });
      it("a failed read: refused with the retryable message, definitively, and nothing is sent", async () => {
        ROLLOUT.value = "error";
        const out = await createTreatmentAreaWithEntryAction(input as never);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error).toBe(ROLLOUT_UNAVAILABLE_MESSAGE_SAVE);
        expect(out.unresolved).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
      });
      it("On: reads the rollout once and goes on to the command", async () => {
        ROLLOUT.value = "on";
        await createTreatmentAreaWithEntryAction(input as never);
        expect(ROLLOUT.reads).toBe(1);
        expect(rpc).toHaveBeenCalled();
      });
      it("a unit that is NOT the xCell makes no rollout read, whatever the rollout says", async () => {
        UNIT.profileId = "fixture:other";
        ROLLOUT.value = "error";
        await createTreatmentAreaWithEntryAction(input as never);
        expect(ROLLOUT.reads).toBe(0);
      });
    });
  }
});
