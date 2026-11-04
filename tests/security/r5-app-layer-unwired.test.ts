import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// R5 prepared app layer: erasure requests and the contact-audit view are UNWIRED until their migrations (held 0295, 0290) are numbered,
// reviewed and applied. This pins that nothing renders or calls them yet and that none of the new code logs or echoes personal data.
// When wiring is approved, REMOVE the matching entry from WIRING_ALLOWED in the same change: that is the point of the pin.
const ROOT = path.resolve(__dirname, "../..");
const NEW_FILES = [
  "lib/erasure/requests.ts",
  "lib/erasure/commands.ts",
  "app/(app)/settings/data/erasure-actions.ts",
  "app/(app)/settings/data/ErasureRequestsSection.tsx",
  "lib/clients/contact-audit-view.ts",
  "app/(app)/clients/[id]/ContactAuditList.tsx",
];
const WIRING_ALLOWED: Record<string, string[]> = {
  // importer -> modules it may import (the new files wiring each other)
  "lib/erasure/commands.ts": ["lib/erasure/requests.ts"],
  "app/(app)/settings/data/erasure-actions.ts": ["lib/erasure/commands.ts", "lib/erasure/requests.ts"],
  "app/(app)/settings/data/ErasureRequestsSection.tsx": ["lib/erasure/requests.ts"],
  "app/(app)/clients/[id]/ContactAuditList.tsx": ["lib/clients/contact-audit-view.ts"],
};

function walk(rel: string): string[] {
  return readdirSync(path.join(ROOT, rel)).flatMap((n) => {
    const r = path.join(rel, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(path.join(ROOT, r)).isDirectory() ? walk(r) : /\.(ts|tsx)$/.test(r) ? [r] : [];
  });
}
const code = (f: string) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stem = (f: string) => f.replace(/\.(ts|tsx)$/, "");
const importPaths = (f: string) => [...code(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

describe("R5 prepared app layer is unwired", () => {
  const all = [...walk("app"), ...walk("lib"), ...walk("components")];
  it("the new files exist", () => { for (const f of NEW_FILES) expect(all, f).toContain(f); });

  it("no other source file imports any of them", () => {
    const targets = NEW_FILES.map((f) => ({ f, specs: [`@/${stem(f)}`, `./${path.basename(stem(f))}`] }));
    const offenders: string[] = [];
    for (const importer of all) {
      if (NEW_FILES.includes(importer)) continue;
      for (const spec of importPaths(importer)) for (const t of targets) if (t.specs.includes(spec) || spec.endsWith(`/${path.basename(stem(t.f))}`) && spec.includes(path.dirname(t.f).split("/").pop() ?? "§")) offenders.push(`${importer} -> ${t.f}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the new files import each other only along the allowed edges", () => {
    for (const [importer, allowed] of Object.entries(WIRING_ALLOWED)) {
      const local = importPaths(importer).filter((s) => NEW_FILES.some((n) => s === `@/${stem(n)}`));
      for (const s of local) expect(allowed.map((a) => `@/${stem(a)}`), `${importer} imports ${s}`).toContain(s);
    }
  });

  it("none of them logs, or echoes a database message, an id, a reason or a name", () => {
    for (const f of NEW_FILES) {
      const c = code(f);
      expect(c, f).not.toMatch(/console\.(log|error|warn|info|debug)/);
      expect(c, f).not.toMatch(/Sentry\./);
      expect(c, f).not.toMatch(/error\.message|\.message\b/);
    }
  });

  it("no new file names the held tables or commands anywhere a page could reach them without going through the guarded files", () => {
    const readers = all.filter((f) => !NEW_FILES.includes(f) && !f.startsWith("tests/") && /client_erasure_request|request_client_erasure|client_contact_audit/.test(code(f)));
    expect(readers).toEqual([]);
  });
});
