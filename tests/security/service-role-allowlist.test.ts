import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SERVICE_ROLE_ALLOWLIST,
  type ServiceRoleAllowlistEntry,
} from "./service-role-allowlist";

// PR #313. Service-role (createAdminClient) inventory + drift gate.
//
// createAdminClient() BYPASSES RLS, so an overlooked/new usage could quietly
// break studio isolation. This test pins EVERY runtime call site under app/ and
// lib/ to the allowlist, and requires each to declare a purpose, an RLS-bypass
// justification, and a scopeGuard symbol that ACTUALLY appears in the file. A
// new usage (or a dropped guard) fails CI. This complements the browser
// boundary test (admin-server-boundary.test.ts), it inventories the SERVER
// side. It is an inventory/drift gate, NOT a proof every query is scoped.

const REPO_ROOT = path.resolve(__dirname, "../..");
const FACTORY = "lib/supabase/admin-server.ts";

// Live call sites: every file under app/ or lib/ that CALLS createAdminClient()
// (not just imports it), excluding tests and the factory itself.
function liveCallSites(): string[] {
  const out = execSync(
    `grep -rlE "createAdminClient\\(\\)" app lib --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
    { cwd: REPO_ROOT },
  )
    .toString()
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => p !== FACTORY)
    .filter((p) => !/\.(test|spec)\.(ts|tsx)$/.test(p))
    .sort();
  return Array.from(new Set(out));
}

const ALLOWLIST_PATHS = SERVICE_ROLE_ALLOWLIST.map((e) => e.path).sort();

const HINT =
  "\n\nservice-role drift: createAdminClient() bypasses RLS. Update " +
  "tests/security/service-role-allowlist.ts, add/remove the entry with a " +
  "{ path, purpose, why, scopeGuard } where scopeGuard is a real token/" +
  "signature/studio/client/appointment guard string present in the file.";

describe("service-role allowlist: the live call-site set == the allowlist", () => {
  it("has no NEW unallowlisted createAdminClient() usage", () => {
    const live = liveCallSites();
    const missing = live.filter((p) => !ALLOWLIST_PATHS.includes(p));
    expect(missing, `Unallowlisted service-role usage: ${missing.join(", ")}${HINT}`).toEqual([]);
  });

  it("has no STALE allowlist entries (listed but no longer a call site)", () => {
    const live = liveCallSites();
    const stale = ALLOWLIST_PATHS.filter((p) => !live.includes(p));
    expect(stale, `Stale allowlist entries (remove them): ${stale.join(", ")}${HINT}`).toEqual([]);
  });

  it("the two sets are exactly equal", () => {
    expect(liveCallSites()).toEqual(ALLOWLIST_PATHS);
  });

  it("createAdminClient is only constructed in the allowlisted factory", () => {
    const factory = readFileSync(path.join(REPO_ROOT, FACTORY), "utf8");
    expect(factory).toMatch(/export function createAdminClient\(/);
    // No OTHER file builds a service-role client directly from the key.
    const directKey = execSync(
      `grep -rlE "createClient\\([^)]*SERVICE_ROLE_KEY" app lib --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
      { cwd: REPO_ROOT },
    )
      .toString()
      .trim();
    expect(directKey, "Direct service-role client outside the factory").toBe("");
  });
});

describe("service-role allowlist: every entry is justified", () => {
  it("no duplicate paths", () => {
    const seen = new Set<string>();
    for (const e of SERVICE_ROLE_ALLOWLIST) {
      expect(seen.has(e.path), `duplicate allowlist entry: ${e.path}`).toBe(false);
      seen.add(e.path);
    }
  });

  it("every entry has a non-empty purpose, why, and scopeGuard", () => {
    for (const e of SERVICE_ROLE_ALLOWLIST) {
      expect(e.purpose.trim().length, `${e.path}: empty purpose`).toBeGreaterThan(0);
      expect(e.why.trim().length, `${e.path}: empty why`).toBeGreaterThan(0);
      expect(e.scopeGuard.trim().length, `${e.path}: empty scopeGuard`).toBeGreaterThan(0);
    }
  });

  it("each scopeGuard string is actually present in its file (unless justificationOnly)", () => {
    for (const e of SERVICE_ROLE_ALLOWLIST) {
      if (e.justificationOnly) {
        // Escape hatch: no single stable guard symbol. Require STRONG prose
        // instead so the reviewer must think about scope explicitly.
        expect(e.why.trim().length, `${e.path}: justificationOnly needs strong prose`).toBeGreaterThan(80);
        continue;
      }
      const src = readFileSync(path.join(REPO_ROOT, e.path), "utf8");
      expect(
        src.includes(e.scopeGuard),
        `${e.path}: scopeGuard "${e.scopeGuard}" not found in file (guard dropped or renamed?)${HINT}`,
      ).toBe(true);
    }
  });

  it("keeps the justificationOnly escape hatch rare (< 5% of entries)", () => {
    const jo = SERVICE_ROLE_ALLOWLIST.filter((e) => e.justificationOnly).length;
    expect(jo).toBeLessThan(Math.ceil(SERVICE_ROLE_ALLOWLIST.length * 0.05));
  });
});
