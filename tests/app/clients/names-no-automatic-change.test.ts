import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// HON-58 (Sam): "Do not enable legal-name access or change existing client names automatically."
// The app side of that: the ONLY writers of clients.name / preferred_name are the explicit staff
// create and edit actions, the edit writes preferred_name only when the form submitted it, nothing
// copies a legal name onto a client row, and no code path seeds a legal identity.

const update = readFileSync("app/(app)/clients/[id]/actions.ts", "utf8");
const create = readFileSync("app/(app)/clients/new/actions.ts", "utf8");
const legal = readFileSync("app/(app)/clients/[id]/legal-identity-actions.ts", "utf8");

describe("no automatic name changes", () => {
  it("the edit writes preferred_name only inside the submitted-field guard", () => {
    expect(update).toMatch(/formData\.has\("preferred_name"\)/);
    expect(update).toMatch(/\.\.\.\(preferredRead && preferredRead\.ok \? \{ preferred_name: preferredRead\.value \} : \{\}\)/);
    expect((update.match(/preferred_name:/g) ?? []).length).toBe(1);
  });
  it("saving a legal name never touches the clients table", () => {
    expect(legal).not.toMatch(/from\("clients"\)\s*\.(update|insert|upsert)/);
    expect(legal).toMatch(/from\("client_legal_identities"\)\.upsert/);
    expect(legal).not.toMatch(/preferred_name/);
  });
  it("the legal identity is staff entry only: source is fixed, nothing infers or imports it", () => {
    expect(legal).toMatch(/source: "staff_entry"/);
    const code = legal.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/insurer|backfill|csv/i);
  });
  it("creating a client stores what staff typed: name as given, preferred name or null", () => {
    expect(create).toMatch(/preferred_name: preferred\.value,/);
  });
  it("no migration in this change set exists for names (the S1 files arrive via the record PR)", () => {
    const migs = readdirSync("supabase/migrations").filter((f) => /hon58|legal_name|preferred/i.test(f));
    // Any such file must be one of the three S1 migrations; this PR adds none.
    for (const f of migs) expect(f).toMatch(/^(0258_hon58_identity|0266_legal_name_receptionist_access|0272_hon58_legal_identity_hardening)\.sql$/);
  });
});
