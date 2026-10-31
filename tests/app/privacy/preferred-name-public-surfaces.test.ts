import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-58 Q3 (Privacy PEER-0258-0266-SQL, C3): no preferred-name field on public
// booking, and the new clients.preferred_name column reaches no unauthenticated
// or client-facing surface. clients carries every existing grant and select(*),
// so this is pinned in source for the public and portal route trees (the
// catalog side, anon-executable functions, is pinned in
// tests/db/hon58-legal-identity-hardening.db.test.ts).
//
// The intake QUESTION key "preferred_name" (lib/intake/questions.ts) is a form
// answer the client types, not the clients column, and lives outside these roots.

const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_ROOTS = [
  "app/book",
  "app/cancel",
  "app/intake",
  "app/invitation",
  "app/manage",
  "app/portal",
  "app/reschedule",
  "app/calendar-feed",
];
const FORBIDDEN = /preferred_name|preferredName|legal_name|client_legal_identities/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("preferred and legal names stay off public and portal surfaces", () => {
  const files = PUBLIC_ROOTS.flatMap((r) => sources(path.join(ROOT, r)));

  it("scans the public route trees (cannot pass by scanning nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes(`${path.sep}book${path.sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${path.sep}portal${path.sep}`))).toBe(true);
  });

  it("no file there names preferred_name, a legal name, or the legal-identity table", () => {
    const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("CONTROL: the pattern catches each forbidden spelling", () => {
    for (const s of ["preferred_name", "preferredName", "legal_name", "client_legal_identities"]) {
      expect(FORBIDDEN.test(`select ${s} from x`)).toBe(true);
    }
  });
});
