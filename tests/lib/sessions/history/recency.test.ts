import { describe, expect, it } from "vitest";
import {
  SESSION_RECENCY_ORDER,
  applySessionRecencyOrder,
  isStrictlyBeforeCanonical,
  parseCanonicalInstant,
} from "@/lib/sessions/history/recency";

describe("the order is TOTAL, and it is emitted from ONE place", () => {
  it("is started_at DESC then id DESC", () => {
    expect(SESSION_RECENCY_ORDER).toEqual([
      { column: "started_at", ascending: false },
      { column: "id", ascending: false },
    ]);
  });

  it("ends in the primary key, which is what makes it total", () => {
    // Without this, a tie on started_at leaves the planner to decide which row
    // survives a LIMIT. Measured on this schema: 9 of 13 rows differ between a
    // sequential-scan and an index-scan plan.
    const last = SESSION_RECENCY_ORDER[SESSION_RECENCY_ORDER.length - 1];
    expect(last!.column).toBe("id");
  });

  it("applies every key to the query, in order", () => {
    const calls: Array<[string, boolean]> = [];
    const q = {
      order(column: string, o: { ascending: boolean }) {
        calls.push([column, o.ascending]);
        return q;
      },
    };
    applySessionRecencyOrder(q);
    expect(calls).toEqual([
      ["started_at", false],
      ["id", false],
    ]);
  });

  it("exports no comparator — the database sorts, JavaScript never does", async () => {
    const mod = await import("@/lib/sessions/history/recency");
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/compare|sortBy|newestFirst|byRecency/i);
    }
  });
});

describe("instants are parsed at DATABASE precision, not Date precision", () => {
  it("keeps microseconds that getTime() would discard", () => {
    // The divergence that retired the previous attempt. These two instants are
    // 200µs apart: strictly ordered in Postgres, exactly EQUAL to V8.
    const a = "2026-03-12T14:00:00.000123+00:00";
    const b = "2026-03-12T14:00:00.000456+00:00";
    expect(new Date(a).getTime()).toBe(new Date(b).getTime()); // the control
    expect(isStrictlyBeforeCanonical(a, b)).toBe(true);
    expect(isStrictlyBeforeCanonical(b, a)).toBe(false);
  });

  it("reads a TRIMMED fraction as its true value, not its digit count", () => {
    // Postgres trims trailing zeros, so `.5` and `.500000` are the same instant.
    // Parsing the fraction as a number would make `.5` FIVE microseconds.
    expect(parseCanonicalInstant("2026-03-12T14:00:00.5Z")!.micros).toBe(500000);
    expect(parseCanonicalInstant("2026-03-12T14:00:00.500000Z")!.micros).toBe(500000);
    expect(parseCanonicalInstant("2026-03-12T14:00:00.05Z")!.micros).toBe(50000);
    expect(
      isStrictlyBeforeCanonical("2026-03-12T14:00:00.05Z", "2026-03-12T14:00:00.5Z"),
    ).toBe(true);
  });

  it("handles a whole second, a Z suffix and a non-UTC offset", () => {
    expect(parseCanonicalInstant("2026-03-12T14:00:00Z")!.micros).toBe(0);
    // Same instant, expressed two ways.
    const utc = parseCanonicalInstant("2026-03-12T14:00:00Z")!;
    const offset = parseCanonicalInstant("2026-03-12T15:00:00+01:00")!;
    expect(offset.epochSeconds).toBe(utc.epochSeconds);
    expect(parseCanonicalInstant("2026-03-12T15:00:00+0100")!.epochSeconds).toBe(
      utc.epochSeconds,
    );
  });

  it("an unparseable instant is UNKNOWN, never silently false", () => {
    // `false` would drop a real row; `true` would admit a row the appointment's
    // boundary excludes. The caller must refuse it.
    for (const bad of [null, undefined, "", "not-a-timestamp", "2026-03-12", 42 as never]) {
      expect(parseCanonicalInstant(bad)).toBeNull();
      expect(isStrictlyBeforeCanonical(bad, "2026-03-12T14:00:00Z")).toBeNull();
      expect(isStrictlyBeforeCanonical("2026-03-12T14:00:00Z", bad)).toBeNull();
    }
  });

  it("is STRICT: an instant is not before itself", () => {
    // A visit starting at the same instant as the appointment is not previous.
    const t = "2026-03-12T14:00:00.000500+00:00";
    expect(isStrictlyBeforeCanonical(t, t)).toBe(false);
  });

  it("orders across a second and across a day", () => {
    expect(
      isStrictlyBeforeCanonical("2026-03-12T14:00:00.999999Z", "2026-03-12T14:00:01Z"),
    ).toBe(true);
    expect(
      isStrictlyBeforeCanonical("2026-03-12T23:59:59.999999Z", "2026-03-13T00:00:00Z"),
    ).toBe(true);
  });
});
