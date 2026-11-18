import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Multi-area + per-area laterality charting UI + write/read wiring (migration
// 0128). The DB/RLS behaviour is proven in tests/db/session-block-areas.db.test.ts
// and the model in tests/lib/block-areas.test.ts; these pin the action write
// contract + the form integration.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const EDITOR = read("components/multi-area-editor.tsx");

describe("MultiAreaEditor behaviour", () => {
  it("supports per-area laterality, remove, and apply-to-all", () => {
    expect(EDITOR).toMatch(/function setLaterality/);
    expect(EDITOR).toMatch(/function remove/);
    expect(EDITOR).toMatch(/function applyToAll/);
    expect(EDITOR).toMatch(/Apply this side to all/);
    expect(EDITOR).toMatch(/LATERALITY_VALUES\.map/);
  });
});

describe("block-setup-form drives the structured areas set", () => {
  it("seeds the editor from structured rows or legacy fallback on edit", () => {
    expect(FORM).toMatch(/areas: resolveBlockAreas\(initialAreas \?\? \[\]/);
  });
});

describe("write action persists canonical rows + a safe legacy projection", () => {
  it("routes EVERY area-selection save (one, many, or zero) through the atomic RPC", () => {
    // The write is canonical: whether the submitted set replaces the stored one
    // is driven by whether `areas` was PROVIDED, not by the count — so
    // many→one/zero never leaves stale rows. L18 Phase 2 keeps that distinction
    // and hands it to the command: an explicit set (including an empty one)
    // replaces; an ABSENT set sends null, meaning "leave the recorded areas
    // alone" — the legacy single-area edit path.
    expect(ACTIONS).toMatch(/const areaRows = areaSetCheck \? areaSetCheck\.value : null/);
    expect(ACTIONS).toMatch(/p_areas: areaRows\s*\n?\s*\? areaRows\.map/);
    expect(ACTIONS).toMatch(/:\s*null,/);
  });
  it("passes an optimistic-concurrency token + maps the stale conflict", () => {
    expect(ACTIONS).toMatch(/p_expected_updated_at: input\.expectedUpdatedAt/);
    // The stale-conflict marker itself now lives in the shared error mapper, so
    // the action detects it through `isStaleBlockVersion` rather than matching
    // the raw database string inline. Same user-facing outcome.
    expect(ACTIONS).toMatch(/isStaleBlockVersion\(cmdErr\)/);
    expect(ACTIONS).toMatch(/changed elsewhere/);
    const MAPPER = read("lib/sessions/block-command-errors.ts");
    expect(MAPPER).toMatch(/stale_block_version/);
  });
  it("saves block + area set ATOMICALLY via the migration-0129 RPCs (no partial set)", () => {
    // L18 Phase 2: the application calls the 0166 commands, which call the
    // 0129 RPCs internally — the block, its COMPLETE area set and the coupled
    // entry now commit in ONE transaction rather than two.
    expect(ACTIONS).toMatch(/"create_block_with_entry"/);
    expect(ACTIONS).toMatch(/rpc\("update_block_with_entry"/);
    const MIGRATION = read("supabase/migrations/0166_session_block_electrolysis_commands.sql");
    expect(MIGRATION).toMatch(/public\.create_session_block_with_areas\(/);
    expect(MIGRATION).toMatch(/public\.update_session_block_with_areas\(/);
    // The old non-atomic app-side delete-then-insert is gone.
    expect(ACTIONS).not.toMatch(/function replaceBlockAreaSet/);
    expect(ACTIONS).not.toMatch(/\.from\("session_block_areas"\)/);
  });
});
