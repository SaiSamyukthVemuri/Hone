import { afterEach, describe, expect, it, vi } from "vitest";

import { safeLog, withoutRecordIds } from "@/lib/logging/safe-log";

// ===========================================================================
// #828 G-26 (egress-audit row 25): server console output reaches Vercel
// runtime logs, so no record id may be logged. Every value is SYNTHETIC.
// ===========================================================================

const CLIENT = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const APPT = "ABCDEF12-3456-4789-8ABC-DEF012345678"; // upper case
const STUDIO = "11111111-2222-4333-8444-555555555555";
const IDS = [CLIENT, SESSION, APPT, STUDIO];

function expectNoRecordId(logged: unknown[], where: string): void {
  const text = logged
    .map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack ?? ""}` : JSON.stringify(a)))
    .join(" ")
    .toLowerCase();
  for (const id of IDS) expect(text, `${where} still carries ${id}`).not.toContain(id.toLowerCase());
  expect(text).not.toContain("%2d4a5b");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLog removes record ids from every argument shape", () => {
  it("strings, compound identifiers and percent-encoded hyphens", () => {
    const out = withoutRecordIds([
      `session_load_failed:${SESSION}`,
      `client=${CLIENT} hone_booking_${APPT}`,
      `/clients/${CLIENT.replace(/-/g, "%2D")}`,
    ]);
    expectNoRecordId(out, "strings");
    expect(out[0]).toBe("session_load_failed:[id]");
    expect(out[1]).toBe("client=[id] hone_booking_[id]");
  });

  it("objects and arrays: values and keys, at depth", () => {
    const out = withoutRecordIds([
      { clientId: CLIENT, nested: { list: [SESSION, { appt: APPT }] }, [STUDIO]: "key" },
    ]);
    expectNoRecordId(out, "objects");
    expect(out[0]).toEqual({ clientId: "[id]", nested: { list: ["[id]", { appt: "[id]" }] }, "[id]": "key" });
  });

  it("Error: message and stack lose ids; name and extra fields kept, scrubbed", () => {
    const err = Object.assign(new Error(`row ${CLIENT} missing`), { code: "PGRST116", details: `id=${SESSION}` });
    const [out] = withoutRecordIds([err]) as [Error & { code?: string; details?: string }];
    expectNoRecordId([out], "Error");
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe("row [id] missing");
    expect(out.code).toBe("PGRST116");
    expect(out.details).toBe("id=[id]");
    expect(err.message).toContain(CLIENT); // the caller's object is not mutated
  });

  it("leaves non-id content, numbers, null and undefined as they were", () => {
    const out = withoutRecordIds(["booking_slot_db_error:insert:23505", 42, null, undefined, true, { code: "42501" }]);
    expect(out).toEqual(["booking_slot_db_error:insert:23505", 42, null, undefined, true, { code: "42501" }]);
  });

  it("does not touch a longer dashless hex run (not a UUID)", () => {
    const hex = `a${CLIENT.replace(/-/g, "")}ff`;
    expect(withoutRecordIds([hex])).toEqual([hex]);
  });

  it("a cycle or excessive depth is dropped, never logged unscrubbed", () => {
    const cyclic: Record<string, unknown> = { id: CLIENT };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: SESSION };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const out = withoutRecordIds([cyclic, deep]);
    expectNoRecordId(out, "cycle/depth");
  });
});

describe("safeLog.error / warn / info hand scrubbed arguments to console", () => {
  for (const level of ["error", "warn", "info"] as const) {
    it(`${level}`, () => {
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      safeLog[level]("event_failed", { clientId: CLIENT }, new Error(`appt ${APPT}`));
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]!;
      expectNoRecordId(args, `console.${level}`);
      expect(args[0]).toBe("event_failed");
    });
  }
});
