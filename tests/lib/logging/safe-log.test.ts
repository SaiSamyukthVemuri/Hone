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

  it("an id glued to hex letters on either side (Codex P1 4301586679)", () => {
    const out = withoutRecordIds([`abc${CLIENT}`, `${SESSION}fed`, `deadbeef${APPT}cafe`]);
    expectNoRecordId(out, "hex-adjacent");
    expect(out).toEqual(["abc[id]", "[id]fed", "deadbeef[id]cafe"]);
  });

  it("a UUID whose hex digits are percent-encoded (Codex P2 4301707490, on #891)", () => {
    const ENCODED = `/clients/%36f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e%35 and %30a1b2c3d%2D4e5f-4061-8273-8495a6b7c8d%39`;
    expect(withoutRecordIds([ENCODED])).toEqual(["/clients/[id] and [id]"]);
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

// ---------------------------------------------------------------------------
// THE GUARANTEE for encodings: no string or key, after ASCII percent-decoding
// to a fixed point, contains a UUID. The oracle below decodes the OUTPUT fully
// and searches it; inputs are fuzzed per character (raw, %XX, %25XX, either
// case), glued to letters, with a fixed seed so a failure reproduces.
// ---------------------------------------------------------------------------
function oracleDecode(text: string): string {
  let cur = text;
  for (let i = 0; i < 16; i += 1) {
    const next = cur.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeFuzzed(id: string, rnd: () => number): string {
  return [...id]
    .map((ch) => {
      const hex = ch.charCodeAt(0).toString(16);
      const r = rnd();
      const esc = rnd() < 0.5 ? hex : hex.toUpperCase();
      if (r < 0.4) return ch;
      if (r < 0.75) return `%${esc}`;
      if (r < 0.95) return `%25${esc}`;
      return `%2525${esc}`;
    })
    .join("");
}

const FUZZ_IDS = [CLIENT, SESSION, APPT, STUDIO];
const FUZZ_CASES = Array.from({ length: 400 }, (_v, i) => {
  const rnd = mulberry32(828 + i);
  const id = FUZZ_IDS[i % FUZZ_IDS.length]!;
  const glue = ["", "abc", "x_", "9"][Math.floor(rnd() * 4)]!;
  return `/clients/${glue}${encodeFuzzed(id, rnd)}${glue ? "fed" : ""}/sessions?tab=1`;
});

describe("THE GUARANTEE for encodings (ASCII percent-decoding to a fixed point)", () => {
  it("400 fuzzed encodings: no UUID survives in the fully decoded output", () => {
    for (const input of FUZZ_CASES) {
      const [out] = withoutRecordIds([input]) as [string];
      expect(UUID_ANYWHERE.test(oracleDecode(out)), `${input} -> ${out}`).toBe(false);
    }
  });

  it("keys get the same guarantee", () => {
    const [out] = withoutRecordIds([Object.fromEntries(FUZZ_CASES.slice(0, 50).map((k, i) => [k, i]))]);
    for (const key of Object.keys(out as object)) expect(UUID_ANYWHERE.test(oracleDecode(key)), key).toBe(false);
  });

  it("an id-bearing token is written decoded, keeping the route shape", () => {
    expect(withoutRecordIds([`/clients/%36f1c2d3e%252D4a5b-4c6d-8e7f-90a1b2c3d4e5/sessions`])).toEqual(["/clients/[id]/sessions"]);
  });

  it("a token still changing after the decode bound is dropped, never sent undecoded", () => {
    const deep = `/clients/%2525252536f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5`;
    expect(withoutRecordIds([deep])).toEqual(["[Redacted]"]);
  });

  it("decoding never injects a control character or whitespace (Codex P2 4301838851)", () => {
    const FORGE = `{"clientId":"${"6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5"}","message":"bad%0Aforged%1B[31m%20x"}`;
    const [out] = withoutRecordIds([FORGE]) as [string];
    expect(out).not.toMatch(/[\x00-\x20\x7f]/);
    expect(out).toBe(`{"clientId":"[id]","message":"bad%0Aforged%1B[31m%20x"}`);
  });

  it("only the id span is replaced; every other escape is written back unchanged (Codex P2 4301902163)", () => {
    const forged = `bad%22,%22event%22:%22success%22,%22id%22:%22${CLIENT}%22`;
    const [out] = withoutRecordIds([forged]) as [string];
    expect(out).toBe("bad%22,%22event%22:%22success%22,%22id%22:%22[id]%22");
    const mixed = `/c/foo%40example.test/%36f1c2d3e%252D4a5b-4c6d-8e7f-90a1b2c3d4e5%3Fx`;
    expect(withoutRecordIds([mixed])).toEqual(["/c/foo%40example.test/[id]%3Fx"]);
  });

  it("astral characters before an id: offsets are UTF-16, nothing corrupted, nothing thrown (Codex P2 4301959849)", () => {
    const ASTRAL = `💥%20${"6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5"}%20x 😀${"0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9"}%20y 🎉%20dp%5F1TestDispute9Ab`;
    expect(withoutRecordIds([ASTRAL])).toEqual(["💥%20[id]%20x 😀[id]%20y 🎉%20dp%5F1TestDispute9Ab"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => safeLog.error(`😀${CLIENT}%`)).not.toThrow();
    expect(spy.mock.calls[0]).toEqual(["😀[id]%"]);
  });

  it("tokens with % but no id keep their original encoding", () => {
    expect(withoutRecordIds(["100% done", "q=a%20b&r=%2Fx", "bad %zz escape"])).toEqual(["100% done", "q=a%20b&r=%2Fx", "bad %zz escape"]);
  });
});
