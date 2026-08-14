import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// L18 Phase 1A migrated ONE server action (addLaserEntryAction) onto the narrow
// 0164 command. L18 Phase 2 migrates the rest: addElectrolysisEntryAction now
// calls `add_electrolysis_pass` (migration 0166), which finds-or-creates the
// primary block and writes the entry in ONE transaction, so the block-coupling
// that kept it behind in Phase 1A is resolved rather than merely tolerated.
// Source-contract style, matching the other action tests in this suite: these
// actions reach Supabase, `revalidatePath` and `getCurrentPractitionerWithStudio`,
// so the behavioural proof lives in tests/db/entry-create-commands.db.test.ts,
// tests/db/session-block-electrolysis-commands.db.test.ts and the browser lane.

const SRC = readFileSync(
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
  "utf8",
);

function bodyOf(fn: string): string {
  const start = SRC.indexOf(`export async function ${fn}`);
  expect(start, `${fn} not found`).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nexport async function", start + 10);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

describe("addLaserEntryAction: calls create_laser_entry", () => {
  const body = bodyOf("addLaserEntryAction");

  it("calls the 0164 command and no longer inserts directly", () => {
    expect(body).toMatch(/rpc\("create_laser_entry"/);
    expect(body).not.toMatch(/from\("laser_entries"\)[\s\S]{0,200}?\.insert\(/);
  });

  it("passes the session and the asserted client", () => {
    expect(body).toMatch(/p_session_id:\s*sessionId/);
    expect(body).toMatch(/p_client_id:\s*clientId/);
  });

  it("preserves its equipment-params shaping and zone requirement", () => {
    expect(body).toMatch(/p_equipment_params:/);
    expect(body).toMatch(/Object\.keys\(equipmentParams\)\.length > 0 \? equipmentParams : null/);
    expect(body).toMatch(/if \(!zone\) throw new Error\("Zone is required\."\)/);
  });

  it("preserves its error message and revalidation contract", () => {
    expect(body).toMatch(/throw new Error\(`Failed to add entry: \$\{error\.message\}`\)/);
    expect(body).toMatch(/revalidatePath\(`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\)/);
  });

  it("keeps its authorization checks", () => {
    expect(body).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(body).toMatch(/assertSessionVisible\(studio\.id, clientId, sessionId\)/);
  });
});

describe("addElectrolysisEntryAction: calls add_electrolysis_pass", () => {
  const BLOCK_SRC = readFileSync(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    "utf8",
  );
  const body = bodyOf("addElectrolysisEntryAction");

  it("calls the 0166 command and no longer inserts directly", () => {
    expect(body).toMatch(/rpc\("add_electrolysis_pass"/);
    expect(body).not.toMatch(/from\("electrolysis_entries"\)[\s\S]{0,400}?\.insert\(/);
  });

  it("passes the session and the asserted client", () => {
    expect(body).toMatch(/p_session_id:\s*sessionId/);
    expect(body).toMatch(/p_client_id:\s*clientId/);
  });

  it("hands block resolution to the command instead of creating one itself", () => {
    // The legacy block-less caller shape is still supported; what changed is
    // WHERE the first block is created. `ensureBlockForSession` no longer
    // exists as a writer, the command finds-or-creates under a row lock, in
    // the same transaction as the entry.
    expect(body).toMatch(/p_block_id:\s*explicitBlockId/);
    expect(body).toMatch(/p_block_defaults:\s*blockDefaults/);
    expect(SRC).not.toMatch(/async function ensureBlockForSession/);
    const helper = SRC.slice(SRC.indexOf("function defaultBlockValues"));
    expect(helper.slice(0, 900)).not.toMatch(/\.insert\(|\.update\(|createClient\(/);
  });

  it("keeps its server-authoritative retirement of galvanic_intensity_percent", () => {
    // The command takes no parameter for it, so a new row always stores NULL,
    // now enforced by the database rather than by an application literal.
    expect(body).not.toMatch(/p_galvanic_intensity_percent/);
    expect(body).not.toMatch(/formData\.get\("galvanic_intensity_percent"\)/);
  });

  it("keeps the discriminated result contract and the separate chip read-back", () => {
    expect(body).toMatch(/code:\s*"not_persisted"/);
    expect(body).toMatch(/code:\s*"unverified"/);
    expect(body).toMatch(/from\("electrolysis_entries"\)[\s\S]{0,200}?\.select\("observation_chips"\)/);
    expect(body).toMatch(/return \{ ok: true, entryId, observationChips \}/);
  });

  it("never surfaces a raw database message", () => {
    expect(body).toMatch(/mapBlockCommandError\(error\)/);
    expect(body).not.toMatch(/error\?\.message/);
  });

  it("keeps its authorization checks", () => {
    expect(body).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(body).toMatch(/assertSessionVisible\(studio\.id, clientId, sessionId\)/);
  });

  it("the two treatment-area actions call the coupled commands", () => {
    expect(BLOCK_SRC).toMatch(/"create_block_with_entry"/);
    expect(BLOCK_SRC).toMatch(/rpc\("update_block_with_entry"/);
    // The Phase 1A exception label is retired along with the exception.
    expect(BLOCK_SRC).not.toContain("TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION");
  });

  it("no unreviewed electrolysis command was invented", () => {
    expect(SRC).not.toMatch(/create_electrolysis_entry/);
    expect(BLOCK_SRC).not.toMatch(/create_electrolysis_entry|create_laser_entry/);
  });
});
