import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 0178 — the APPLICATION half of the practitioner identity boundary.
//
// The database half is proved behaviourally in tests/db/. This file proves the
// two things the DB cannot see:
//
//   1. every former direct writer now goes through a governed command, and none
//      of them reports success for a write that did not happen;
//   2. the platform-global ops-alert resolver states its plurality and
//      lookup-failure rules in code — the BEHAVIOUR is driven through the real
//      action in tests/app/admin/ops-alert-attribution.test.ts.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");

const PROFILE = read("app/(app)/settings/profile/actions.ts");
const BLOCKS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
const OPS = read("app/admin/ops-alerts/actions.ts");

// ---------------------------------------------------------------------------
// A — the five former direct writers
// ---------------------------------------------------------------------------
describe("0178 — the practitioner direct writers are gone", () => {
  it("no runtime module writes public.practitioners directly any more", () => {
    for (const [name, src] of [
      ["profile actions", PROFILE],
      ["block actions", BLOCKS],
      ["ops alerts", OPS],
    ] as const) {
      const code = codeOnly(src);
      const chains = [...code.matchAll(/\.from\(\s*["']practitioners["']\s*\)([\s\S]{0,220})/g)];
      for (const [, tail] of chains) {
        expect(tail, `${name}: direct practitioner write`).not.toMatch(
          /\.(update|insert|upsert|delete)\(/,
        );
      }
    }
  });

  it("profile actions call the governed commands and pass an explicit studio", () => {
    const code = codeOnly(PROFILE);
    expect(code).toContain('supabase.rpc(\n    "update_own_practitioner_profile"');
    expect(code).toContain('supabase.rpc(\n    "set_own_calendar_feed_token_hash"');
    // The studio is explicit for deterministic multi-membership resolution, and
    // NO practitioner id is sent — the database binds the actor to auth.uid().
    expect((code.match(/p_studio_id: studio\.id/g) ?? []).length).toBe(4);
    expect(code).not.toMatch(/p_practitioner_id|practitioner\.id/);
  });

  it("a zero-row preference write is NEVER reported as success", () => {
    // This is the bug 0178 fixes: the owner-gated RLS silently updated nothing
    // for every non-owner, and the action still resolved happily.
    const code = codeOnly(PROFILE);
    expect(code).toMatch(/if \(!updatedId\) \{\s*\n\s*throw new Error\("Failed to save your name/);
    expect(code).toMatch(/if \(!updatedId\) \{\s*\n\s*throw new Error\("Failed to save your color/);
    expect(code).toMatch(/if \(error \|\| !rotatedId\)/);
    expect(code).toMatch(/if \(error \|\| !clearedId\)/);
  });

  it("machine frequency uses the authenticated command, not the admin bypass, and stays best-effort", () => {
    const fn =
      BLOCKS.match(/async function rememberMachineFrequencyDefault[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toContain('supabase.rpc("set_own_default_machine_frequency"');
    expect(fn).not.toMatch(/createAdminClient/);
    // The clinical block row has already saved; a preference failure must never
    // fail or roll back a successful clinical write.
    expect(fn).toMatch(/try \{[\s\S]*\} catch \{[\s\S]*\}/);
  });
});

// ---------------------------------------------------------------------------
// B — ops-alert attribution
// ---------------------------------------------------------------------------
// The BEHAVIOUR (0 / 1 / 2 memberships and a lookup failure) is driven through
// the real action in tests/app/admin/ops-alert-attribution.test.ts. Recomputing
// the rule here would pass even if the action ignored its own resolver, so this
// file keeps only what a source contract can honestly own.
describe("0178 — the ops resolver states its plurality and failure rules in code", () => {
  it("reads plural rows, distinguishes a lookup error, and never uses first-row semantics", () => {
    const src = codeOnly(OPS);
    expect(src).toMatch(/const \{ data: practitionerRows, error: practitionerLookupError \}/);
    expect(src).toContain("practitionerRows.length === 1");
    expect(src).toMatch(/if \(practitionerLookupError\)/);
    expect(src).not.toMatch(/\.maybeSingle\(\)|\.single\(\)|\.limit\(1\)/);
    expect(src).toContain("resolved_by_practitioner_id: practitionerId,");
  });

  it("logs a BOUNDED diagnostic — an event name and a code, never row or user data", () => {
    const src = codeOnly(OPS);
    expect(src).toContain("ops_alert_resolver_practitioner_lookup_failed");
    expect(src).toMatch(/code: practitionerLookupError\.code \?\? "unknown"/);
    expect(src).not.toMatch(/practitionerLookupError\.message|practitionerLookupError\.details/);
  });
});
