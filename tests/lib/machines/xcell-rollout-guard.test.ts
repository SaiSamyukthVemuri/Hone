import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineDb } from "@/lib/machines/machine-queries";

// THE GUARD'S TWO LOOKUPS, against a fake that APPLIES EVERY `.eq` IT IS GIVEN. A fake that ignored a filter would let a lookup that
// forgot its session scope pass every test, so each row here carries the columns the code must filter on and a decoy that differs in exactly one.

const ROLLOUT = vi.hoisted(() => ({ value: "off" as "on" | "off" | "error", reads: 0 }));
vi.mock("@/lib/rollouts/charting-rollout", async (orig) => {
  const real = await orig<typeof import("@/lib/rollouts/charting-rollout")>();
  return { ...real, readChartingRollout: async () => { ROLLOUT.reads += 1; return ROLLOUT.value; } };
});
const { guardXcellRollout, createReceiptLookup, submissionReceiptLookup, XCELL_ROLLOUT_OFF_MESSAGE } = await import("@/lib/machines/xcell-rollout-guard");

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {};
const LOG: Array<{ table: string; filters: Record<string, unknown> }> = [];
const fakeDb = (): MachineDb =>
  ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        limit: async () => {
          LOG.push({ table, filters: { ...filters } });
          const rows = (TABLES[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          return { data: rows, error: null };
        },
      };
      return chain;
    },
  }) as unknown as MachineDb;

const PUR = "dectro-apilus:xcell-pur";
const where = { studioId: "studio-1", unitProfileId: PUR, deviceId: "unit-1", blockId: "block-1", sessionId: "s1" };

beforeEach(() => {
  ROLLOUT.value = "off";
  ROLLOUT.reads = 0;
  LOG.length = 0;
  for (const k of Object.keys(TABLES)) delete TABLES[k];
});

describe("the existing-block exemption filters by block AND session AND unit", () => {
  it("a block in THIS session already storing this unit is exempt (no rollout read)", async () => {
    TABLES.session_blocks = [{ id: "block-1", session_id: "s1", studio_machine_id: "unit-1" }];
    expect(await guardXcellRollout(fakeDb(), where)).toEqual({ ok: true });
    expect(ROLLOUT.reads).toBe(0);
    expect(LOG[0]!.filters).toEqual({ id: "block-1", session_id: "s1" });
  });
  it("the same block id under ANOTHER session is not exempt: the rollout decides", async () => {
    TABLES.session_blocks = [{ id: "block-1", session_id: "another-session", studio_machine_id: "unit-1" }];
    const out = await guardXcellRollout(fakeDb(), where);
    expect(out).toMatchObject({ ok: false, error: XCELL_ROLLOUT_OFF_MESSAGE });
    expect(ROLLOUT.reads).toBe(1);
  });
  it("a block storing a DIFFERENT unit is not exempt", async () => {
    TABLES.session_blocks = [{ id: "block-1", session_id: "s1", studio_machine_id: "unit-2" }];
    expect(await guardXcellRollout(fakeDb(), where)).toMatchObject({ ok: false });
  });
});

describe("a receipt decides BEFORE the rollout is read", () => {
  const { XCELL_RECEIPT_UNKNOWN_MESSAGE } = { XCELL_RECEIPT_UNKNOWN_MESSAGE: "We could not check whether an earlier attempt saved. Reload the chart to check it." };
  it("found passes whatever the rollout says, and reads no rollout", async () => {
    for (const v of ["off", "error"] as const) {
      ROLLOUT.value = v; ROLLOUT.reads = 0;
      expect(await guardXcellRollout(fakeDb(), { ...where, receipt: async () => "found" }), v).toEqual({ ok: true });
      expect(ROLLOUT.reads, v).toBe(0);
    }
  });
  it("none meets the rollout; unknown is refused as unresolved without a rollout read", async () => {
    expect(await guardXcellRollout(fakeDb(), { ...where, receipt: async () => "none" })).toMatchObject({ ok: false, error: XCELL_ROLLOUT_OFF_MESSAGE });
    ROLLOUT.reads = 0;
    expect(await guardXcellRollout(fakeDb(), { ...where, receipt: async () => "unknown" })).toMatchObject({ ok: false, error: XCELL_RECEIPT_UNKNOWN_MESSAGE, reason: "receipt" });
    expect(ROLLOUT.reads).toBe(0);
  });
});

describe("submissionReceiptLookup maps the existing lookup, and a failure is never none", () => {
  const UNKNOWN = "We could not check whether an earlier attempt saved. Reload the chart to check it.";
  it("true is found, false is none, null is unknown, and a THROWING lookup is unknown", async () => {
    expect(await submissionReceiptLookup(async () => true)()).toBe("found");
    expect(await submissionReceiptLookup(async () => false)()).toBe("none");
    expect(await submissionReceiptLookup(async () => null)()).toBe("unknown");
    expect(await submissionReceiptLookup(async () => { throw new Error("boom"); })()).toBe("unknown");
  });
  it("a throwing lookup is refused as unresolved by the guard, with NO rollout read, for either rollout value", async () => {
    for (const v of ["off", "on"] as const) {
      ROLLOUT.value = v; ROLLOUT.reads = 0;
      const out = await guardXcellRollout(fakeDb(), { ...where, receipt: submissionReceiptLookup(async () => { throw new Error("boom"); }) });
      expect(out, v).toMatchObject({ ok: false, error: UNKNOWN, reason: "receipt" });
      expect(ROLLOUT.reads, v).toBe(0);
    }
  });
});

describe("the create receipt lookup filters by session AND key", () => {
  const TABLE = "treatment_area_create_claims";
  it("finds a receipt for this session and key, and asks with exactly those two filters", async () => {
    TABLES[TABLE] = [{ session_id: "s1", idempotency_key: "key-0001-aaaa", block_id: "b" }];
    expect(await createReceiptLookup(fakeDb(), "s1", "key-0001-aaaa")()).toBe("found");
    expect(LOG[0]!.filters).toEqual({ session_id: "s1", idempotency_key: "key-0001-aaaa" });
  });
  it("the same key under ANOTHER session is none; another key in this session is none", async () => {
    TABLES[TABLE] = [
      { session_id: "another-session", idempotency_key: "key-0001-aaaa", block_id: "b" },
      { session_id: "s1", idempotency_key: "key-0002-bbbb", block_id: "c" },
    ];
    expect(await createReceiptLookup(fakeDb(), "s1", "key-0001-aaaa")()).toBe("none");
  });
});
