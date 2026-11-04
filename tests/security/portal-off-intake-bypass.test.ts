import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// R5 / DN-20 (Sam, batch 3 Q20): with the client portal OFF, existing portal sessions and links are refused on the NEXT request, and the
// independent intake and consent links must be provably unable to BYPASS that restriction. This is the SOURCE half of the proof (who can
// create or read a portal session, and which files can reach portal-only data). It is a tripwire, not a runtime proof: the OFF behaviour
// against a real database value needs the held 0252 column on an owned stack. Synthetic: reads files only, no data, no network.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  return readdirSync(abs).flatMap((name) => {
    const r = path.join(rel, name);
    return statSync(path.join(ROOT, r)).isDirectory() ? walk(r) : [r];
  });
}
const sources = (rel: string) => walk(rel).filter((f) => /\.tsx?$/.test(f));
// Comments describe the rule and may name the very things banned in code.
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("portal OFF: intake and consent links cannot reach the portal (source proof)", () => {
  const intake = sources("app/intake");

  it("the intake token surface exists and is non-trivial (the scan below is not vacuous)", () => {
    expect(intake.length).toBeGreaterThanOrEqual(4);
    expect(intake.some((f) => f.endsWith("[token]/actions.ts"))).toBe(true);
    expect(intake.some((f) => f.endsWith("[token]/page.tsx"))).toBe(true);
  });

  it("(a)(b)(c)(d) no intake file imports anything from the portal: no session, no portal action, no portal read", () => {
    for (const f of intake) {
      const c = code(f);
      expect(c, f).not.toMatch(/from\s+["']@\/lib\/portal\//);
      expect(c, f).not.toMatch(/from\s+["']@\/app\/portal\//);
      expect(c, f).not.toMatch(/from\s+["'](\.\.\/)+portal\//);
    }
  });

  it("no intake file creates, reads or names the portal session cookie or the portal session table", () => {
    for (const f of intake) {
      const c = code(f);
      expect(c, f).not.toMatch(/hone_portal_session/);
      expect(c, f).not.toMatch(/client_portal_sessions/);
      expect(c, f).not.toMatch(/createPortalSession|getCurrentPortalSession|requirePortalSessionForAction|destroyPortalSession/);
    }
  });

  it("no intake file reads the portal's own tables (messages, saved cards, magic links)", () => {
    for (const f of intake) {
      const c = code(f);
      expect(c, f).not.toMatch(/\.from\(\s*["'](client_portal_[a-z_]+|portal_[a-z_]+)["']/);
      expect(c, f).not.toMatch(/payment_methods|stripe_customer|client_card/);
    }
  });
});

describe("portal OFF: every way into a portal session or portal data runs the policy check", () => {
  it("a portal session is created in exactly one place, and that place checks studioPortalAccess first", () => {
    const callers = [...sources("app"), ...sources("lib")].filter((f) => /createPortalSession\s*\(/.test(code(f)) && !/export async function createPortalSession/.test(code(f)));
    expect(callers).toEqual(["app/portal/verify/[token]/actions.ts"]);
    const c = code(callers[0]);
    const gate = c.indexOf("studioPortalAccess(");
    const create = c.indexOf("createPortalSession(");
    expect(gate, "verify action must call the OFF gate").toBeGreaterThan(-1);
    expect(gate, "the gate must run BEFORE the session is created").toBeLessThan(create);
  });

  it("the raw cookie reader is not exported, so no caller can read a session while skipping the studio policy", () => {
    const c = code("lib/portal/session.ts");
    expect(c).toMatch(/async function readCurrentPortalSession\(/);
    expect(c).not.toMatch(/export\s+(async\s+)?function\s+readCurrentPortalSession/);
    expect(c).not.toMatch(/export\s*\{[^}]*readCurrentPortalSession/);
  });

  it("the session resolver refuses a studio whose portal is OFF and fails CLOSED when the policy is unreadable", () => {
    const c = code("lib/portal/session.ts");
    const state = c.slice(c.indexOf("export async function getCurrentPortalSessionState"), c.indexOf("export async function getCurrentPortalSession()"));
    expect(state).toMatch(/if \(!policy\.ok\) return \{ kind: "none" \}/);
    expect(state).toMatch(/if \(!policy\.policy\.portal\)\s*\{\s*return \{ kind: "disabled"/);
    expect(state).toMatch(/return \{ kind: "active", session \}/);
  });

  it("every portal server-action file that touches data resolves the session (or the pre-session gate) through the policy-checked helpers", () => {
    const GUARDS = /getCurrentPortalSession\(|getCurrentPortalSessionState\(|requirePortalSessionForAction\(|studioPortalAccess\(/;
    // logout only destroys the caller's own cookie and reads no client data.
    const NO_DATA = new Set(["app/portal/logout/actions.ts"]);
    const files = sources("app/portal").filter((f) => /(actions?|route)\.tsx?$/.test(f) && !NO_DATA.has(f));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const c = code(f);
      if (!/createAdminClient|\.from\(|\.rpc\(/.test(c)) continue;
      expect(c, `${f} touches data without the portal policy check`).toMatch(GUARDS);
    }
    for (const f of NO_DATA) expect(code(f)).not.toMatch(/\.from\(|\.rpc\(|createAdminClient/);
  });
});
