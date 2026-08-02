import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// L18 Phase 1A — the ONE migrated server action (addLaserEntryAction) must call
// the narrow 0164 command and keep its existing public contract.
//
// addElectrolysisEntryAction is NOT migrated and is asserted UNCHANGED below:
// when the form omits `block_id` it calls ensureBlockForSession, which INSERTs
// a session_blocks row before the entry is written, so it is block-coupled and
// moves with the combined phase. Source-contract style,
// matching the other action tests in this suite: these actions reach Supabase,
// `revalidatePath` and `getCurrentPractitionerWithStudio`, so the behavioural
// proof lives in tests/db/entry-create-commands.db.test.ts and the browser lane.

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

describe("addLaserEntryAction — calls create_laser_entry", () => {
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

describe("the electrolysis writers are ALL deferred and unchanged", () => {
  const BLOCK_SRC = readFileSync(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    "utf8",
  );

  it("addElectrolysisEntryAction still inserts directly and was NOT migrated", () => {
    const body = bodyOf("addElectrolysisEntryAction");
    expect(body).toMatch(/from\("electrolysis_entries"\)[\s\S]{0,400}?\.insert\(/);
    expect(body).not.toMatch(/create_electrolysis_entry/);
  });

  it("addElectrolysisEntryAction is block-coupled via ensureBlockForSession", () => {
    // THIS is why it could not move in this phase: with no submitted block_id
    // it creates a session_blocks row first, in a separate transaction from the
    // entry write. A failed entry write would leave that block behind.
    const body = bodyOf("addElectrolysisEntryAction");
    expect(body).toMatch(/ensureBlockForSession\(/);
    const helper = SRC.slice(SRC.indexOf("async function ensureBlockForSession"));
    expect(helper).toMatch(/from\("session_blocks"\)[\s\S]{0,200}?\.insert\(/);
  });

  it("it keeps its server-authoritative retirement of galvanic_intensity_percent", () => {
    const body = bodyOf("addElectrolysisEntryAction");
    expect(body).toMatch(/galvanic_intensity_percent:\s*null/);
    expect(body).not.toMatch(/formData\.get\("galvanic_intensity_percent"\)/);
  });

  it("the two treatment-area actions are unchanged and labelled", () => {
    for (const fn of [
      "createTreatmentAreaWithEntryAction",
      "updateTreatmentAreaWithEntryAction",
    ]) {
      const start = BLOCK_SRC.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const preamble = BLOCK_SRC.slice(Math.max(0, start - 2500), start);
      expect(preamble).toContain("TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION");
    }
  });

  it("no electrolysis command exists in this phase", () => {
    expect(SRC).not.toMatch(/create_electrolysis_entry/);
    expect(BLOCK_SRC).not.toMatch(/create_electrolysis_entry|create_laser_entry/);
  });
});
