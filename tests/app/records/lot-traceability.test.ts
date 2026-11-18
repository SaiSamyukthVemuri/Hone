import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  escapeIlikeExact,
  normalizeLotSearch,
} from "@/lib/record-keeping/queries";

// PR #213: probe lot traceability. Exact normalized matching (trim +
// case-insensitive, never fuzzy) connecting Sterile Items records to
// the treatment areas that recorded the same lot. Traceability only;
// never causation.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/records/page.tsx");
const QUERIES = read("lib/record-keeping/queries.ts");

describe("lot matching (pure)", () => {
  it("normalizes by trimming; blank means no search", () => {
    expect(normalizeLotSearch("  460941 ")).toBe("460941");
    expect(normalizeLotSearch("")).toBeNull();
    expect(normalizeLotSearch("   ")).toBeNull();
    expect(normalizeLotSearch(undefined)).toBeNull();
  });

  it("ILIKE wildcards are escaped so the match is literal, not fuzzy", () => {
    expect(escapeIlikeExact("460941")).toBe("460941");
    expect(escapeIlikeExact("lot%1")).toBe("lot\\%1");
    expect(escapeIlikeExact("lot_1")).toBe("lot\\_1");
    expect(escapeIlikeExact("a\\b")).toBe("a\\\\b");
  });

  it("matching is case-insensitive exact via escaped ilike on both sides", () => {
    expect(QUERIES).toMatch(/\.ilike\("lot_number", pattern\)/);
    expect(QUERIES).toMatch(/\.ilike\("probe_lot_number", pattern\)/);
    // No wildcard is ever appended to the pattern.
    expect(QUERIES).not.toMatch(/`%\$\{|pattern \+ "%"|"%" \+ pattern/);
  });
});

describe("safety wording", () => {
  it("traceability wording only; never causation or lot judgments", () => {
    const panel = PAGE.slice(PAGE.indexOf("LotTraceabilityPanel"));
    for (const p of [
      /caused/i,
      /unsafe/i,
      /bad lot/i,
      /problem lot/i,
      /recommend/i,
      /\bsafe\b/i,
      /linked to irritation/i,
    ]) {
      expect(panel).not.toMatch(p);
      expect(QUERIES.slice(QUERIES.indexOf("PR #213"))).not.toMatch(p);
    }
  });
});

describe("security", () => {
  it("read-only, studio-scoped, never trusts client studio_id", () => {
    const trace = QUERIES.slice(QUERIES.indexOf("getLotTraceability"));
    expect(trace).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(trace).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("no public/booking/intake/portal/email/cron/API exposure", () => {
    const out = execSync(
      'grep -rl "getLotTraceability\\|LotTraceability" app/book app/portal app/intake app/cancel app/reschedule lib/email app/api 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
  });
});
