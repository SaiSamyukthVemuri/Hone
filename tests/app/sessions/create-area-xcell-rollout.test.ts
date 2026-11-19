import { beforeEach, describe, expect, it, vi } from "vitest";

// THE ROLLOUT, ASKED AGAIN WHEN A NEW AREA IS CREATED. A rollout read once when choices load is not enough, because a form opened while
// the unit was offered can submit after it is switched Off. Both create routes that carry a unit (the identity-only save and the save
// with settings) re-read the rollout before anything is sent, EXCEPT that a create whose key already has a receipt is a lost-answer retry of
// an attempt that committed: it is replayed (creating nothing new) and never refused with a claim that nothing was saved. Synthetic ids only.

const rpc = vi.fn();
const ROLLOUT = vi.hoisted(() => ({ value: "on" as "on" | "off" | "error", reads: 0 }));
const UNIT = vi.hoisted(() => ({ profileId: "dectro-apilus:xcell-pur" }));
const CLAIM = vi.hoisted(() => ({ result: { data: [] as unknown[], error: null as null | { message: string } }, reads: 0 }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => rpc(name, args),
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
          eq: () => ({ limit: async () => { CLAIM.reads += 1; return CLAIM.result; } }),
        }),
      }),
    }),
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
const { XCELL_ROLLOUT_OFF_MESSAGE, ROLLOUT_UNAVAILABLE_MESSAGE_SAVE, XCELL_RECEIPT_UNKNOWN_MESSAGE } = await import("@/lib/machines/xcell-rollout-guard");

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
  CLAIM.result = { data: [], error: null };
  CLAIM.reads = 0;
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

  for (const [name, input] of ROUTES) {
    describe(`${name}: a lost-answer RETRY whose first attempt committed`, () => {
      it("Off or a failed read, WITH a receipt for the key: replayed, never refused, never says nothing was saved", async () => {
        for (const v of ["off", "error"] as const) {
          rpc.mockClear(); ROLLOUT.value = v; ROLLOUT.reads = 0;
          CLAIM.result = { data: [{ block_id: "b1" }], error: null };
          const out = await createTreatmentAreaWithEntryAction(input as never);
          expect(rpc, v).toHaveBeenCalledTimes(1); // the command answers the retry from its own receipt
          expect(ROLLOUT.reads, v).toBe(0); // the receipt is looked up BEFORE the rollout is read
          if (!out.ok) expect(out.error, v).not.toContain("Nothing was saved");
        }
      });
      it("Off with NO receipt for the key: refused as before", async () => {
        ROLLOUT.value = "off";
        const out = await createTreatmentAreaWithEntryAction(input as never);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.error).toBe(XCELL_ROLLOUT_OFF_MESSAGE);
        expect(CLAIM.reads).toBe(1);
        expect(rpc).not.toHaveBeenCalled();
      });
      it("a FAILED receipt lookup is not 'no receipt': refused without claiming nothing was saved, and the outcome stays unresolved", async () => {
        ROLLOUT.value = "off";
        CLAIM.result = { data: [], error: { message: "boom" } };
        const out = await createTreatmentAreaWithEntryAction(input as never);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error).toBe(XCELL_RECEIPT_UNKNOWN_MESSAGE);
        expect(out.error).not.toContain("Nothing was saved");
        expect(out.unresolved).toBe(true);
        expect(rpc).not.toHaveBeenCalled();
      });
      it("a unit that is NOT the xCell looks up no receipt", async () => {
        UNIT.profileId = "fixture:other";
        await createTreatmentAreaWithEntryAction(input as never);
        expect(CLAIM.reads).toBe(0);
      });
    });
  }
});
