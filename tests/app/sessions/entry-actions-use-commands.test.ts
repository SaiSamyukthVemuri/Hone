import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// L18 Phase 1A — the two migrated server actions must call the narrow 0164
// commands and keep their existing public contract. Source-contract style,
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

describe("addElectrolysisEntryAction — calls create_electrolysis_entry", () => {
  const body = bodyOf("addElectrolysisEntryAction");

  it("calls the 0164 command and no longer inserts directly", () => {
    expect(body).toMatch(/rpc\(\s*\n?\s*"create_electrolysis_entry"/);
    expect(body).not.toMatch(/from\("electrolysis_entries"\)[\s\S]{0,200}?\.insert\(/);
  });

  it("passes the session and the asserted client so the command can re-check lineage", () => {
    expect(body).toMatch(/p_session_id:\s*sessionId/);
    expect(body).toMatch(/p_client_id:\s*clientId/);
  });

  it("does NOT pass a studio, practitioner or actor id", () => {
    expect(body).not.toMatch(/p_studio_id|p_practitioner_id|p_created_by|p_actor/);
  });

  it("does NOT pass the retired galvanic_intensity_percent", () => {
    expect(body).not.toMatch(/p_galvanic_intensity_percent/);
  });

  it("preserves the mode-gated reading parameters", () => {
    for (const p of [
      "p_galvanic_ma",
      "p_galvanic_duration_seconds",
      "p_thermolysis_intensity_percent",
      "p_thermolysis_duration_seconds",
      "p_units_of_lye",
      "p_observation_chips",
      "p_pulse_count",
      "p_pulse_delay_seconds",
    ]) {
      expect(body, `${p} must still be sent`).toContain(p);
    }
  });

  it("keeps the persisted-row verification read and its result contract", () => {
    // The verification SELECT is a READ and is deliberately retained: the
    // command returns the id from its INSERT ... RETURNING, so the chip check
    // must still be a SEPARATE query by that id.
    expect(body).toMatch(/from\("electrolysis_entries"\)[\s\S]{0,120}?\.select\("observation_chips"\)/);
    expect(body).toMatch(/code:\s*"unverified"/);
    expect(body).toMatch(/code:\s*"not_persisted"/);
    expect(body).toMatch(/code:\s*"invalid_input"/);
    expect(body).toMatch(/return \{ ok: true, entryId, observationChips \}/);
  });

  it("keeps its revalidation behaviour", () => {
    expect(body).toMatch(/revalidatePath\(`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\)/);
    expect(body).toMatch(/revalidatePath\(`\/clients\/\$\{clientId\}`\)/);
  });

  it("keeps the pre-write validation that must fail before any insert", () => {
    expect(body).toMatch(/parseSubmittedChips/);
    expect(body).toMatch(/CHIPS_UNREADABLE_ERROR/);
    expect(body).toMatch(/validateProbeLotId/);
    expect(body).toMatch(/assertSessionVisible\(studio\.id, clientId, sessionId\)/);
  });
});

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

describe("the deferred block-coupled actions are unchanged", () => {
  const BLOCK_SRC = readFileSync(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    "utf8",
  );

  it("both still write electrolysis_entries directly, and are labelled", () => {
    for (const fn of [
      "createTreatmentAreaWithEntryAction",
      "updateTreatmentAreaWithEntryAction",
    ]) {
      const start = BLOCK_SRC.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const preamble = BLOCK_SRC.slice(Math.max(0, start - 2500), start);
      expect(preamble).toContain("TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION");
    }
    expect(BLOCK_SRC).toMatch(/from\("electrolysis_entries"\)[\s\S]{0,200}?\.insert\(/);
  });

  it("neither was migrated to the 0164 commands in this phase", () => {
    expect(BLOCK_SRC).not.toMatch(/create_electrolysis_entry|create_laser_entry/);
  });
});
