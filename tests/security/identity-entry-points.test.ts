import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Identity readiness (Privacy R3/R5, Insurance C-1/C-7), app side. Source contracts: they pin who may WRITE a
// client's identity, where the studio comes from, and that no app code reads a legal name on a receptionist's
// behalf. The database-level cross-studio and receptionist proofs need a local stack and run in the DB lane.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const APP_FILES = [...walk("app"), ...walk("lib"), ...walk("components")];

const STAFF_IDENTITY_WRITERS = [
  "app/(app)/clients/new/actions.ts",
  "app/(app)/clients/[id]/actions.ts",
  "app/(app)/clients/[id]/legal-identity-actions.ts",
  "app/(app)/calendar/actions.ts",
  "app/(app)/settings/import/actions.ts",
];

describe("every staff identity writer takes its studio from the session, never from the request", () => {
  it.each(STAFF_IDENTITY_WRITERS)("%s", (file) => {
    const src = code(read(file));
    expect(src).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    // No studio id is ever read from the form, a URL or a body.
    expect(src).not.toMatch(/formData\.get\(["']studio/);
    expect(src).not.toMatch(/searchParams[^;]*studio_id/);
  });

  it("the profile update, the legal-name write and the quick-create carry the session studio on the write itself", () => {
    const update = code(read("app/(app)/clients/[id]/actions.ts"));
    expect(update).toMatch(/\.update\(\{[\s\S]*?\}\)\s*\.eq\("id", clientId\)\s*\.eq\("studio_id", studio\.id\)/);
    const legal = code(read("app/(app)/clients/[id]/legal-identity-actions.ts"));
    expect(legal).toMatch(/studio_id: studio\.id/);
    expect(legal).toMatch(/\.eq\("client_id", clientId\)\s*\.eq\("studio_id", studio\.id\)/);
    for (const f of ["app/(app)/clients/new/actions.ts", "app/(app)/calendar/actions.ts"]) {
      expect(code(read(f))).toMatch(/\.insert\(\{\s*studio_id: studio\.id/);
    }
    expect(code(read("app/(app)/settings/import/actions.ts"))).toMatch(/studio_id: ctx\.studioId/);
  });
});

describe("legal identity has exactly one writer and no receptionist reader (R4, R5, C-1)", () => {
  // The export registry only CATALOGUES every table (names, tiers, review notes); it reads no row.
  const CATALOGUE = ["lib/export/resource-registry.ts"];
  const touching = (needle: RegExp) =>
    APP_FILES.filter((f) => !CATALOGUE.includes(f)).filter((f) => needle.test(code(read(f))));

  it("only the explicit legal-name action writes client_legal_identities", () => {
    const writers = APP_FILES.filter((f) => {
      const src = code(read(f));
      return /from\("client_legal_identities"\)\s*\.(insert|update|upsert|delete)\(/.test(src);
    });
    expect(writers).toEqual(["app/(app)/clients/[id]/legal-identity-actions.ts"]);
  });

  it("the receptionist legal-name switch has no caller in the app (it stays hidden)", () => {
    expect(touching(/set_receptionist_legal_name_access|studio_legal_name_access|client_legal_name_access_audit/)).toEqual([]);
  });

  it("no file that reads a legal name mentions a receptionist, and no receptionist RPC is called from the app", () => {
    for (const f of touching(/client_legal_identities|can_read_client_legal_identity/)) {
      expect(code(read(f)), f).not.toMatch(/receptionist/i);
    }
    expect(touching(/\.rpc\(\s*["'][a-z_]*receptionist[a-z_]*["']/)).toEqual([]);
  });

  it("the receptionist projection reads no legal field and returns the literal Name on file", () => {
    const rules = code(read("lib/clients/directory-rules.ts"));
    expect(rules).not.toMatch(/legal_/);
    expect(rules).toMatch(/row\.nameOnFile \? NAME_ON_FILE_LABEL/);
  });
});

describe("no name value reaches a log, an error or a URL from the identity actions (R8)", () => {
  it.each(["app/(app)/clients/[id]/actions.ts", "app/(app)/clients/[id]/legal-identity-actions.ts"])("%s", (file) => {
    const src = code(read(file));
    // Every console.error line in these files carries an event name and a code, never a value.
    for (const m of src.matchAll(/console\.error\(([\s\S]*?)\);/g)) {
      expect(m[1], m[1]).not.toMatch(/\b(name|legal_|preferred|given|family|conflicts|patch|current)\b[^"]*[,}]/);
    }
    expect(src).not.toMatch(/redirect\([^)]*(name|legal|preferred)/i);
  });
});
