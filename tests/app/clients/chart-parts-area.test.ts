import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// PR #268. "Chart parts" / treatment-area context made visible across charting,
// saved entries, and treatment memory, reusing the existing session_blocks
// area fields (primary_area / side / custom_area_detail, migration 0039) and
// the imported treatment_area_text. Display/labeling only: NO migration, NO
// image storage / body-map / sketch / upload / OCR / AI, and NO copied Jane
// assets. Source-grep, no DB/network.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const BEFORE_TODAY_CARD = read("components/before-today-card.tsx");
const SESSION_BLOCKS_VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const BEFORE_TODAY_BUILDER = read("lib/sessions/before-today.ts");

describe("treatment-memory card names the area (chart parts)", () => {
  it("labels the last treatment's area with an 'Area not recorded' fallback", () => {
    expect(BEFORE_TODAY_CARD).toMatch(/Treatment area:/);
    expect(BEFORE_TODAY_CARD).toMatch(/Area not recorded/);
  });

  it("ties the latest recorded setup to its area", () => {
    expect(BEFORE_TODAY_CARD).toMatch(/Latest recorded setup:/);
    expect(BEFORE_TODAY_BUILDER).toMatch(/areaName/);
  });

  it("keeps imported area separate and explicitly labeled", () => {
    expect(BEFORE_TODAY_CARD).toMatch(/Imported area:/);
    // imported area still reads off treatment_area_text (imported provenance)
    expect(BEFORE_TODAY_CARD).toMatch(/treatmentAreaText/);
  });
});

describe("saved charted entries name the recorded area", () => {
  it("shows a 'Recorded area' / 'Area not recorded' eyebrow", () => {
    expect(SESSION_BLOCKS_VIEW).toMatch(/Recorded area/);
    expect(SESSION_BLOCKS_VIEW).toMatch(/Area not recorded/);
  });

  it("still resolves the area from the existing structured fields (no new schema)", () => {
    expect(SESSION_BLOCKS_VIEW).toMatch(/primary_area/);
    expect(SESSION_BLOCKS_VIEW).toMatch(/custom_area_detail/);
    expect(SESSION_BLOCKS_VIEW).toMatch(/sessionBlockSideLabel/);
  });
});

describe("no copied Jane assets (inspiration only)", () => {
  // Walk app/, components/, lib/, docs/ and assert no Jane CDN/thumbnail URL or
  // image path is referenced. The product-category word "Jane" (import-source
  // label, competitor copy, 'not copied' framing) is allowed; copied ASSETS are
  // not.
  function walk(dir: string): string[] {
    const out: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(join(process.cwd(), dir));
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".next") continue;
      const rel = join(dir, name);
      const st = statSync(join(process.cwd(), rel));
      if (st.isDirectory()) out.push(...walk(rel));
      else if (/\.(ts|tsx|md|mdx)$/.test(name)) out.push(rel);
    }
    return out;
  }

  const files = [
    ...walk("app"),
    ...walk("components"),
    ...walk("lib"),
    ...walk("docs"),
  ];

  it("references no jane.app URL or Jane /thumbs/ asset path anywhere", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (/jane\.app/i.test(src) || /\/thumbs\//i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
