import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@/lib/permissions/catalog";
import { CLIENT_FIELD_GOVERNANCE } from "@/lib/clients/field-groups";

// R5 / DN-5: every column of `clients` has a stated governance, so a new column cannot slip into an existing grant unreviewed.
// Reads lib/types/database.ts as text: the `Client` type is the repository's own statement of the table's columns (the generated-types
// drift check keeps it equal to the migrated schema).

function clientColumns(): string[] {
  const src = readFileSync(path.resolve(__dirname, "../../../lib/types/database.ts"), "utf8");
  const start = src.indexOf("export type Client = {");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n};", start));
  // `name: type` or `name?: type` at the type's top level (two-space indent); comments and continuation lines never start that way.
  return [...body.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1]);
}

describe("client field governance (R5, prepared)", () => {
  const cols = clientColumns();
  const gov = CLIENT_FIELD_GOVERNANCE;

  it("the column list is read (the guard is not vacuous)", () => {
    expect(cols.length).toBeGreaterThan(25);
    expect(cols).toContain("allergies");
    expect(cols).toContain("emergency_contact_phone");
  });

  it("every column of Client has a decided or explicitly-undecided governance; a new column fails here until someone chooses", () => {
    const unmapped = cols.filter((c) => !(c in gov));
    expect(unmapped, `unmapped clients columns: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("the map names no column that Client does not have (a renamed column cannot leave a stale rule)", () => {
    const stale = Object.keys(gov).filter((c) => !cols.includes(c));
    expect(stale).toEqual([]);
  });

  it("every key it names exists in the permission catalog", () => {
    const keys = new Set(CATALOG.map((d) => d.key));
    for (const [col, g] of Object.entries(gov)) {
      if (g.kind !== "keyed") continue;
      expect(keys.has(g.read), `${col} read ${g.read}`).toBe(true);
      expect(keys.has(g.write), `${col} write ${g.write}`).toBe(true);
    }
  });

  it("pronouns travel with display/contact identity and never with legal-name access (batch 1)", () => {
    const p = gov.pronouns;
    expect(p.kind).toBe("keyed");
    if (p.kind !== "keyed") return;
    expect([p.read, p.write]).not.toContain("client.view_legal_name");
    expect([p.read, p.write]).not.toContain("client.edit_legal_name");
    expect(p.write).toBe("client.edit_contact");
  });

  it("legal name is its own pair, used by no other column", () => {
    const users = Object.entries(gov).filter(([, g]) => g.kind === "keyed" && (g.read === "client.view_legal_name" || g.write === "client.edit_legal_name")).map(([c]) => c);
    expect(users).toEqual(["name"]);
  });

  it("emergency contact is UNDECIDED (Q1): nobody has defaulted it into a neighbouring group", () => {
    expect(gov.emergency_contact_name).toEqual({ kind: "undecided", question: "Q1" });
    expect(gov.emergency_contact_phone).toEqual({ kind: "undecided", question: "Q1" });
  });

  it("budget, personal notes, tags and appointment health notes are never bundled into a clients column (they live elsewhere)", () => {
    const bundled = new Set(["client.view_budget", "client.edit_budget", "client.view_personal_notes", "client.edit_personal_notes", "client.view_tags", "client.edit_tags", "client.view_health_fields", "client.edit_health_fields"]);
    for (const [col, g] of Object.entries(gov)) {
      if (g.kind !== "keyed") continue;
      expect(bundled.has(g.read) || bundled.has(g.write), col).toBe(false);
    }
  });

  it("safety (allergies) is separate from the clinical record, and skin type/notes sit in the clinical record", () => {
    expect(gov.allergies).toMatchObject({ kind: "keyed", read: "client.view_allergies_cautions" });
    expect(gov.fitzpatrick_type).toMatchObject({ kind: "keyed", read: "clin.view_records" });
    expect(gov.skin_notes).toMatchObject({ kind: "keyed", read: "clin.view_records" });
  });

  it("consent and opt-out state, archive state and the portrait are never reachable through a staff permission", () => {
    for (const c of ["photo_consent", "sms_consent_at", "sms_consent_source", "sms_opted_out_at", "sms_opt_out_source"]) expect(gov[c].kind, c).toBe("consent");
    for (const c of ["archived_at", "archived_by", "portrait_image_id"]) expect(gov[c].kind, c).toBe("owner_only");
  });
});
