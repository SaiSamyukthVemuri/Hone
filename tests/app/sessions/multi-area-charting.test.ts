import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Multi-area + per-area laterality charting UI + write/read wiring (migration
// 0128). The DB/RLS behaviour is proven in tests/db/session-block-areas.db.test.ts
// and the model in tests/lib/block-areas.test.ts; these pin the action write
// contract + the form/display integration.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const EDITOR = read("components/multi-area-editor.tsx");
const VIEW = read("app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx");
const QUERIES = read("lib/supabase/queries.ts");

describe("MultiAreaEditor behaviour", () => {
  it("adding an area APPENDS (never replaces prior selections) + dedupes", () => {
    expect(EDITOR).toMatch(/onChange\(\[\.\.\.value, \{ area, laterality: "not_applicable" \}\]\)/);
    expect(EDITOR).toMatch(/const exists = value\.some/);
  });
  it("supports per-area laterality, remove, and apply-to-all", () => {
    expect(EDITOR).toMatch(/function setLaterality/);
    expect(EDITOR).toMatch(/function remove/);
    expect(EDITOR).toMatch(/function applyToAll/);
    expect(EDITOR).toMatch(/Apply this side to all/);
    expect(EDITOR).toMatch(/LATERALITY_VALUES\.map/);
  });
  it("shows the areas-treated helper copy", () => {
    expect(EDITOR).toMatch(/Areas treated with these settings/);
    expect(EDITOR).toMatch(/Select every area treated using this settings setup/);
    expect(EDITOR).toMatch(/settings block only when the treatment settings change/);
  });
});

describe("block-setup-form drives the structured areas set", () => {
  it("mounts the MultiAreaEditor bound to draft.areas + submits `areas`", () => {
    expect(FORM).toMatch(/<MultiAreaEditor/);
    expect(FORM).toMatch(/value=\{draft\.areas\}/);
    expect(FORM).toMatch(/areas: draft\.areas/);
  });
  it("renames the primary CTA to settings-block wording", () => {
    expect(FORM).toMatch(/"Add settings block"/);
    expect(FORM).toMatch(/"Edit settings block"/);
  });
  it("seeds the editor from structured rows or legacy fallback on edit", () => {
    expect(FORM).toMatch(/areas: resolveBlockAreas\(initialAreas \?\? \[\]/);
  });
});

describe("write action persists canonical rows + a safe legacy projection", () => {
  it("normalizes the area set + derives the legacy projection", () => {
    expect(ACTIONS).toMatch(/function normalizeAreaSet/);
    expect(ACTIONS).toMatch(/deriveLegacyProjection\(structuredAreas\)/);
    expect(ACTIONS).toMatch(/blockPrimaryArea = proj \? proj\.primaryArea/);
  });
  it("saves block + area set ATOMICALLY via the migration-0129 RPCs (no partial set)", () => {
    expect(ACTIONS).toMatch(/rpc\(\s*"create_session_block_with_areas"/);
    expect(ACTIONS).toMatch(/rpc\(\s*"update_session_block_with_areas"/);
    // The old non-atomic app-side delete-then-insert is gone.
    expect(ACTIONS).not.toMatch(/function replaceBlockAreaSet/);
    expect(ACTIONS).not.toMatch(/\.from\("session_block_areas"\)\s*\n?\s*\.delete\(\)/);
  });
});

describe("read path loads + displays structured areas", () => {
  it("getSessionWithBlocks loads structured_areas per block", () => {
    expect(QUERIES).toMatch(/from\("session_block_areas"\)/);
    expect(QUERIES).toMatch(/structured_areas: areasByBlock\.get\(b\.id\) \?\? \[\]/);
  });
  it("the block view renders every area+laterality (structured precedence) + threads edit seed", () => {
    expect(VIEW).toMatch(/resolveBlockAreas\(block\.structured_areas/);
    expect(VIEW).toMatch(/formatAreaLabel/);
    expect(VIEW).toMatch(/initialAreas=\{resolveBlockAreas\(block\.structured_areas/);
  });
});
