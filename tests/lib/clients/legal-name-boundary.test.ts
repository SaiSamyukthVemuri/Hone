import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientCommunicationName, clientDisplayName } from "@/lib/clients/identity";
import { EXPORT_RESOURCE_REGISTRY as RESOURCE_REGISTRY } from "@/lib/export/resource-registry";

// HON-58 Q1 boundary, application side. The database decides who may read a
// legal name (tests/db/legal-name-access.db.test.ts); these pin that no app
// path can route around it, and the display fallback. Synthetic data only.

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const sources = [...walk("app"), ...walk("lib"), ...walk("components")];
const text = (f: string) => readFileSync(f, "utf8");
// Code only: comments may name the roles they deny.
const code = (f: string) => text(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("display fallback never carries a legal name", () => {
  const withLegal = {
    name: "Margaret Stored",
    legal_given_name: "Marguerite",
    legal_middle_name: "Q",
    legal_family_name: "Zyxwq",
    legal_name: "Marguerite Q Zyxwq",
  };
  it("preferred name wins, else the stored name; the legal fields are never consulted", () => {
    expect(clientDisplayName({ ...withLegal, preferred_name: "Maggie" })).toBe("Maggie");
    expect(clientDisplayName({ ...withLegal, preferred_name: null })).toBe("Margaret Stored");
    expect(clientDisplayName({ ...withLegal, preferred_name: "   " })).toBe("Margaret Stored");
    for (const preferred of ["Maggie", null]) {
      expect(clientDisplayName({ ...withLegal, preferred_name: preferred })).not.toMatch(/Marguerite|Zyxwq/);
      expect(clientCommunicationName({ ...withLegal, preferred_name: preferred })).not.toMatch(/Marguerite|Zyxwq/);
    }
  });
});

describe("no path reads the legal table with a privileged client", () => {
  const readers = sources.filter((f) => /client_legal_identities|@\/lib\/clients\/legal-identity"/.test(text(f)));
  it("finds the readers (non-vacuous)", () => {
    expect(readers.length).toBeGreaterThanOrEqual(4);
  });
  it("none of them imports an admin or service-role client, so the RLS predicate always applies", () => {
    for (const f of readers) {
      if (f.endsWith("resource-registry.ts")) continue; // a registry entry, not a reader
      expect(code(f), f).not.toMatch(/createAdminClient|service_role|SUPABASE_SERVICE_ROLE|@\/lib\/supabase\/admin/);
    }
  });
  it("legal reads are never cached across requests", () => {
    for (const f of readers) expect(text(f), f).not.toMatch(/unstable_cache|\bcache\(|"use cache"|revalidate\s*=\s*[1-9]/);
    for (const f of readers.filter((x) => /page\.tsx$/.test(x))) expect(text(f), f).not.toMatch(/export const dynamic\s*=\s*"force-static"/);
  });
});

describe("a receptionist-facing surface may not bypass the boundary", () => {
  const desk = sources.filter((f) => /^(app\/front-desk|lib\/receptionist)\//.test(f));
  it("uses the display-identity finder (v2), never the stored-name one, and never reads the legal table directly", () => {
    for (const f of desk) {
      expect(text(f), f).not.toMatch(/rpc\(\s*"receptionist_client_contacts"/);
      expect(text(f), f).not.toMatch(/from\(\s*"client_legal_identities"/);
      expect(text(f), f).not.toMatch(/createAdminClient|service_role/);
    }
  });
});

describe("exports omit legal names", () => {
  it("client_legal_identities is not an exported resource, and no exported resource lists a legal_* column", () => {
    const entry = (RESOURCE_REGISTRY as Record<string, { kind: string }>)["client_legal_identities"];
    expect(entry).toBeDefined();
    expect(entry.kind).not.toBe("exported");
    const exported = Object.values(RESOURCE_REGISTRY as Record<string, { kind: string; columns?: Array<{ column: string }> }>);
    for (const r of exported) {
      if (r.kind !== "exported") continue;
      expect(JSON.stringify(r)).not.toMatch(/"legal_(given|middle|family)_name"/);
    }
  });
  it("the export route is owner-only", () => {
    const routes = sources.filter((f) => /export/i.test(f) && /route\.ts$/.test(f));
    for (const f of routes) expect(text(f), f).toMatch(/owner/i);
  });
});

describe("direct routes", () => {
  it("the legal-identity action resolves a practitioner and writes through the signed-in client", () => {
    const f = text("app/(app)/clients/[id]/legal-identity-actions.ts");
    expect(f).not.toMatch(/createAdminClient|service_role/);
    expect(f).toMatch(/createClient/);
  });
  it("the client page reads legal identity with the signed-in client only", () => {
    const f = text("app/(app)/clients/[id]/page.tsx");
    expect(f).toMatch(/readLegalIdentityForSession/);
    expect(f).not.toMatch(/createAdminClient/);
  });
});
