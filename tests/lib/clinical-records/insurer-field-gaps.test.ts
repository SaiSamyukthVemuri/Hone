import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTAKE_STEPS } from "@/lib/intake/questions";
import {
  INSURER_FIELD_GAPS,
  NAME_ON_RECORD_LABEL,
  insurerPacketIdentity,
} from "@/lib/clinical-records/insurer-field-gaps";

// HON-46: the insurer-facing packet must flag missing information rather than
// fabricate it. These tests pin the disclosure, and tie it to the schema so it
// cannot keep saying "not recorded" after a column for the field exists.

// Synthetic only. No real client, studio or identifier.
const SYNTHETIC_CLIENT = { name: "Test Client A" };

describe("insurer field gaps", () => {
  it("names all four missing fields, each once", () => {
    expect(INSURER_FIELD_GAPS.map((g) => g.key)).toEqual([
      "legal_identity",
      "medical_record_number",
      "diagnosis",
      "insurer_member_policy",
    ]);
  });

  it("keeps the MRN and the insurer member/policy number as separate gaps", () => {
    const mrn = INSURER_FIELD_GAPS.find((g) => g.key === "medical_record_number");
    const policy = INSURER_FIELD_GAPS.find((g) => g.key === "insurer_member_policy");
    expect(mrn?.label).not.toEqual(policy?.label);
    expect(policy?.reason).toMatch(/separate from a medical record number/);
  });

  it("states a reason for every gap and never presents a value", () => {
    for (const gap of INSURER_FIELD_GAPS) {
      expect(gap.reason).toMatch(/^Not (recorded|on the client profile)/);
      expect(Object.keys(gap).sort()).toEqual(["key", "label", "reason"]);
    }
  });

  // The intake form collects a legal name, so the disclosure may only say it is
  // missing from the client profile and this packet, never from Hone.
  it("scopes the legal-name gap to the client profile, not to all of Hone", () => {
    const legal = INSURER_FIELD_GAPS.find((g) => g.key === "legal_identity");
    expect(legal?.reason).toMatch(/^Not on the client profile/);
    expect(legal?.reason).toMatch(/neither is included in this packet yet/);
    expect(legal?.reason).not.toMatch(/Not recorded|Hone stores|in Hone/);
  });

  it("does not infer a diagnosis", () => {
    const diagnosis = INSURER_FIELD_GAPS.find((g) => g.key === "diagnosis");
    expect(diagnosis?.reason).toMatch(/does not infer a diagnosis/);
  });
});

describe("insurerPacketIdentity", () => {
  it("prints the stored name under a neutral label, never as legal or preferred", () => {
    const identity = insurerPacketIdentity(SYNTHETIC_CLIENT);
    expect(identity.name).toBe("Test Client A");
    expect(identity.nameLabel).toBe(NAME_ON_RECORD_LABEL);
    expect(identity.nameLabel).not.toMatch(/legal|preferred/i);
  });

  it("still lists the legal name as missing when a name is stored", () => {
    const identity = insurerPacketIdentity(SYNTHETIC_CLIENT);
    expect(identity.gaps.map((g) => g.key)).toContain("legal_identity");
  });

  it("carries no other client column, even when handed a full row", () => {
    const fullRow = {
      ...SYNTHETIC_CLIENT,
      notes: "private note",
      allergies: "synthetic",
      date_of_birth: "2000-01-01",
    };
    const identity = insurerPacketIdentity(fullRow);
    expect(Object.keys(identity).sort()).toEqual(["gaps", "name", "nameLabel"]);
    expect(JSON.stringify(identity)).not.toMatch(/private note|2000-01-01/);
  });
});

// The disclosure is only true while the schema has no column for these fields.
// `Client` in lib/types/database.ts is kept equal to the live schema by the
// generated-types drift check, so reading it here tracks the migrations.
describe("schema tether", () => {
  function clientColumns(): string[] {
    const source = readFileSync(join(process.cwd(), "lib/types/database.ts"), "utf8");
    const start = source.indexOf("export type Client = {");
    expect(start, "export type Client not found").toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n};", start);
    expect(end).toBeGreaterThan(start);
    return source
      .slice(start, end)
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .map((line) => /^([a-z_][a-z0-9_]*)\??:/.exec(line)?.[1])
      .filter((key): key is string => Boolean(key));
  }

  it("reads the Client columns", () => {
    const columns = clientColumns();
    expect(columns).toContain("name");
    expect(columns).toContain("date_of_birth");
  });

  it("ties the legal-name wording to the intake form that collects it", () => {
    // If intake stops asking for a legal name, the scoped wording in
    // lib/clinical-records/insurer-field-gaps.ts should be revisited.
    const keys = INTAKE_STEPS.flatMap((step) => step.questions.map((q) => q.key));
    expect(keys).toContain("legal_name");
  });

  it("has no column for any field the disclosure calls missing", () => {
    // If this fails, HON-58 or HON-60 added the field: revisit
    // lib/clinical-records/insurer-field-gaps.ts so the packet prints the
    // recorded value instead of "Not recorded".
    // HON-58 (0258) added `preferred_name`, which is not one of the insurer
    // fields (the legal identity lives in its own table, never a clients
    // column), so it is the one allowed name here. A `legal_*` column on
    // clients would still be a revisit.
    const suspicious = clientColumns().filter(
      (key) =>
        key !== "preferred_name" &&
        /legal|preferred|mrn|medical_record|diagnos|icd|problem_code|policy|member|insur|payer/.test(key),
    );
    expect(suspicious).toEqual([]);
  });
});
