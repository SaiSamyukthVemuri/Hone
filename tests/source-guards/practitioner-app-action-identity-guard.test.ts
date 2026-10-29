import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// HON-44 — NO SERVER ACTION INSIDE THE AUTHENTICATED APP SHELL IS WITHOUT AN
// IDENTITY GATE.
//
// A receptionist is a studio member but NOT a practitioner (migration 0216,
// studio_receptionists). Every route in app/(app) is reached only through
// resolveActivePractitionerMembership, which returns "none" for a receptionist,
// so a receptionist is refused by the throwing resolver and redirected by the
// route guard. The behaviour of the resolvers is proved in
// tests/app/invite-only-auth.test.ts and tests/lib/supabase/*.test.ts; the
// per-action role decisions in hon-44-owner-only-actions.test.ts and the
// settings tests.
//
// WHAT THIS ADDS: a server action is a public POST endpoint. If a new
// "use server" module under app/(app) forgets to resolve the practitioner, it
// is reachable by anyone who can craft the POST, receptionist included. This
// inventory fails on such a module unless it is listed below WITH its reason.
//
// WHAT IT DOES NOT PROVE: file-level only. It does not show the gate runs
// before every data access inside a file (the recording-stub tests do that for
// the money actions), and it does not read the role. It deliberately does NOT
// touch the payment_charge_attempts read held on 0254.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_SHELL = "app/(app)";

const GATE = /\b(getCurrentPractitionerWithStudio|requirePractitionerWithStudio)\b/;

// Files with no gate call, and why that is acceptable. A stale entry (file gone,
// or now gated) fails the guard, so this list can only shrink or be justified.
const NO_GATE_EXCEPTIONS: Record<string, string> = {
  "app/(app)/dashboard/actions.ts":
    "signOut() only; it ends the caller's own session and reads no studio data.",
  "app/(app)/settings/waitlist/invite-actions.ts":
    "Gate lives in the database: admit_ re-derives membership and owner role from the session (see the file header); the action trusts no role field from the request.",
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function isServerActionModule(src: string): boolean {
  return /^\s*(["'])use server\1;?/m.test(src.split("\n").slice(0, 12).join("\n"));
}

const actionModules = files(path.join(REPO_ROOT, APP_SHELL))
  .map((f) => ({ rel: path.relative(REPO_ROOT, f).split(path.sep).join("/"), src: readFileSync(f, "utf8") }))
  .filter((f) => isServerActionModule(f.src));

describe("HON-44: every app-shell server action module resolves the practitioner", () => {
  it("finds the action modules (the scan is not vacuous)", () => {
    expect(actionModules.length).toBeGreaterThan(20);
  });

  it("each one calls a practitioner resolver, or is a documented exception", () => {
    const ungated = actionModules
      .filter((m) => !GATE.test(m.src))
      .map((m) => m.rel)
      .filter((rel) => !(rel in NO_GATE_EXCEPTIONS));
    expect(ungated, "server action modules under app/(app) with no identity gate").toEqual([]);
  });

  it("no exception is stale: each listed file exists and still has no gate call", () => {
    for (const rel of Object.keys(NO_GATE_EXCEPTIONS)) {
      expect(existsSync(path.join(REPO_ROOT, rel)), `${rel} no longer exists; remove the exception`).toBe(true);
      const m = actionModules.find((a) => a.rel === rel);
      expect(m, `${rel} is no longer a server action module; remove the exception`).toBeDefined();
      expect(GATE.test(m!.src), `${rel} now has a gate call; remove the exception`).toBe(false);
    }
  });
});
