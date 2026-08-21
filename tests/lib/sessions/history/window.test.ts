import { describe, expect, it } from "vitest";
import {
  matchHistorical,
  newestWhere,
  observedWhere,
  unsafeCreateHistoricalWindow,
  type HistoricalAnswer,
} from "@/lib/sessions/history/window";

type Row = { id: string; charted: boolean | null; caution: boolean };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  charted: true,
  caution: false,
  ...over,
});

const complete = (rows: Row[]) =>
  unsafeCreateHistoricalWindow(rows, { kind: "complete" });
const exhausted = (rows: Row[]) =>
  unsafeCreateHistoricalWindow(rows, {
    kind: "exhausted",
    returned: rows.length + 1,
    limit: rows.length,
  });

const tag = <T,>(a: HistoricalAnswer<T>) =>
  matchHistorical(a, {
    observed: (v) => `observed:${(v as { id: string }).id}`,
    none: () => "none",
    indeterminate: () => "indeterminate",
    failed: () => "failed",
  });

describe("recency is safe by construction, even under an exhausted read", () => {
  it("returns the FIRST match — rows are already newest-first", () => {
    expect(tag(newestWhere(complete([row("a"), row("b")]), (r) => r.charted))).toBe(
      "observed:a",
    );
  });

  it("skips non-matching rows to reach the newest that DOES match", () => {
    const w = complete([row("empty", { charted: false }), row("real")]);
    expect(tag(newestWhere(w, (r) => r.charted))).toBe("observed:real");
  });

  it("an EXHAUSTED read still answers a recency question", () => {
    // The top-N theorem: everything unread is OLDER than everything here, so it
    // cannot be the newest.
    expect(tag(newestWhere(exhausted([row("a")]), (r) => r.charted))).toBe(
      "observed:a",
    );
  });
});

describe("an UNDECIDABLE row poisons everything older — the conjunctive half", () => {
  it("a row whose own evidence is missing yields indeterminate, not the older match", () => {
    // THE STALE-SUPERLATIVE DEFECT IN ONE ASSERTION. Skipping the unknown row
    // and returning `older` presents an older visit as "the latest".
    const w = complete([row("unknown", { charted: null }), row("older")]);
    expect(tag(newestWhere(w, (r) => r.charted))).toBe("indeterminate");
  });

  it("but an undecidable row AFTER a match is irrelevant", () => {
    const w = complete([row("newest"), row("unknown", { charted: null })]);
    expect(tag(newestWhere(w, (r) => r.charted))).toBe("observed:newest");
  });
});

describe("absence requires the WHOLE window", () => {
  it("no match under a COMPLETE read is an authoritative none", () => {
    expect(tag(newestWhere(complete([row("x", { charted: false })]), (r) => r.charted))).toBe(
      "none",
    );
  });

  it("no match under an EXHAUSTED read is indeterminate, never none", () => {
    expect(
      tag(newestWhere(exhausted([row("x", { charted: false })]), (r) => r.charted)),
    ).toBe("indeterminate");
  });

  it("an EMPTY exhausted window is indeterminate — the defect in one line", () => {
    expect(tag(newestWhere(exhausted([]), (r) => r.charted))).toBe("indeterminate");
  });

  it("an EMPTY complete window is a real none", () => {
    expect(tag(newestWhere(complete([]), (r) => r.charted))).toBe("none");
  });
});

describe("bare positive facts are FOUND, not ranked", () => {
  it("an older caution survives a newer visit that recorded none", () => {
    // The product rule: a newer charted session WITHOUT notes does not hide the
    // previous session's still-relevant guidance.
    const w = complete([row("newer"), row("older", { caution: true })]);
    expect(tag(observedWhere(w, (r) => r.caution))).toBe("observed:older");
  });

  it("still cannot invent an absence under an exhausted read", () => {
    expect(tag(observedWhere(exhausted([row("a")]), (r) => r.caution))).toBe(
      "indeterminate",
    );
  });

  it("finds none authoritatively under a complete read", () => {
    expect(tag(observedWhere(complete([row("a")]), (r) => r.caution))).toBe("none");
  });
});

describe("the eliminator is TOTAL, and the window cannot be forged", () => {
  it("routes each case to its own handler", () => {
    const cases: Array<[HistoricalAnswer<Row>, string]> = [
      [{ kind: "observed", value: row("v") }, "observed:v"],
      [{ kind: "none" }, "none"],
      [{ kind: "indeterminate" }, "indeterminate"],
      [{ kind: "failed" }, "failed"],
    ];
    for (const [answer, expected] of cases) expect(tag(answer)).toBe(expected);
  });

  it("exposes no escape hatch that could re-collapse the four states", async () => {
    const mod = await import("@/lib/sessions/history/window");
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/unwrap|valueOr|orElse|getOrDefault|toNullable/i);
    }
  });

  it("its brand symbol is module-private", async () => {
    // A consumer that could spell the witness could forge a window from an array
    // it happens to hold, which is what made the previous authority advisory.
    const mod = await import("@/lib/sessions/history/window");
    expect(Object.keys(mod)).not.toContain("HISTORICAL_WINDOW");
  });
});
