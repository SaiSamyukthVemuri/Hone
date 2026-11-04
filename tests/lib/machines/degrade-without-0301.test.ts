import { describe, expect, it, vi } from "vitest";

import { recordSetupSubmission, type MachineDb } from "@/lib/machines/machine-queries";
import { isMissingCommand } from "@/lib/machines/save-attempt";

// ===========================================================================
// MIGRATION-FIRST ORDER CAN SLIP (0301; Privacy EH-1/EH-2)
//
// recordSetupSubmission prefers the identity-recording wrapper. Only a
// MISSING function (PGRST202 / 42883, so nothing ran) may send the same
// arguments to the 0223 command. Both directions, plus the negative controls.
// ===========================================================================

const INPUT = {
  blockId: "block-1",
  machineId: "dev-1",
  modeKey: "flash",
  idempotencyKey: "key-1",
  groups: [
    {
      groupKey: null,
      newGroupRef: "g1",
      channels: [] as number[],
      readings: [
        {
          stageKey: null,
          fieldKey: "current",
          value: { kind: "value" as const, value: 1 },
          nativeUnit: "uA",
          decimals: 0,
          observationSource: "practitioner-entered" as const,
        },
      ],
    },
  ],
  sessionId: "session-1",
  clientId: "client-1",
};

const OK = { submission_id: "22222222-2222-4222-8222-222222222222", groups: 1, readings: 1, reused: false };

function dbWith(answer: (fn: string) => { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (fn: string, _args?: unknown) => answer(fn));
  return { db: { rpc } as unknown as MachineDb, rpc };
}

describe("isMissingCommand", () => {
  it("is exactly PGRST202 and 42883", () => {
    expect(isMissingCommand({ code: "PGRST202" })).toBe(true);
    expect(isMissingCommand({ code: "42883" })).toBe(true);
    for (const code of ["42501", "23514", "P0001", "PGRST116", "", null, undefined]) {
      expect(isMissingCommand({ code })).toBe(false);
    }
    expect(isMissingCommand(null)).toBe(false);
  });
});

describe("recordSetupSubmission without 0301", () => {
  it("falls back to record_treatment_setup_submission with the SAME arguments", async () => {
    const { db, rpc } = dbWith((fn) =>
      fn === "record_setup_submission_with_identity"
        ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
        : { data: OK, error: null },
    );
    const out = await recordSetupSubmission(db, INPUT);
    expect(out.ok).toBe(true);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      "record_setup_submission_with_identity",
      "record_treatment_setup_submission",
    ]);
    expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  });

  it("NEGATIVE CONTROL: an ordinary refusal is returned, never retried on the older command", async () => {
    const { db, rpc } = dbWith(() => ({ data: null, error: { code: "23514", message: "check violation" } }));
    const out = await recordSetupSubmission(db, INPUT);
    expect(out.ok).toBe(false);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["record_setup_submission_with_identity"]);
  });

  it("NEGATIVE CONTROL: a transport failure with no code stays UNRESOLVED and is not retried", async () => {
    const { db, rpc } = dbWith(() => ({ data: null, error: { message: "fetch failed" } }));
    const out = await recordSetupSubmission(db, INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.unresolved).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("with 0301 present: one call, the wrapper", async () => {
    const { db, rpc } = dbWith(() => ({ data: OK, error: null }));
    const out = await recordSetupSubmission(db, INPUT);
    expect(out.ok).toBe(true);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["record_setup_submission_with_identity"]);
  });
});
