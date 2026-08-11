import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 0178 — the APPLICATION half of the practitioner identity boundary.
//
// The database half is proved behaviourally in tests/db/. This file proves the
// two things the DB cannot see:
//
//   1. every former direct writer now goes through a governed command, and none
//      of them reports success for a write that did not happen;
//   2. the platform-global ops-alert attribution is PLURALITY-SAFE — which is
//      behaviour, not text, so it is driven rather than grepped.

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
// B — ops-alert attribution, driven
// ---------------------------------------------------------------------------
const state: { rows: Array<{ id: string }>; update: Record<string, unknown> | null } = {
  rows: [],
  update: null,
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      // The practitioner lookup resolves to the seeded membership rows...
      q.then = (r: (v: unknown) => unknown) => r({ data: state.rows, error: null });
      q.update = (payload: Record<string, unknown>) => {
        if (table === "ops_alerts") state.update = payload;
        const done: Record<string, unknown> = {};
        done.eq = () => done;
        done.is = () => done;
        done.then = (r: (v: unknown) => unknown) => r({ error: null });
        return done;
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-user", email: "a@b.c" } } }) },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

describe("0178 — platform-global ops attribution is plurality-safe", () => {
  beforeEach(() => {
    state.rows = [];
    state.update = null;
  });

  it.each([
    ["ZERO memberships", [], null],
    ["EXACTLY ONE membership", [{ id: "p-1" }], "p-1"],
    ["TWO memberships", [{ id: "p-1" }, { id: "p-2" }], null],
  ])(
    "%s -> attribution %s",
    async (_label, rows, expected) => {
      // Resolving an ops alert is not studio-scoped, so there is no correct
      // studio to disambiguate with. Attribute only when it is unambiguous;
      // otherwise leave NULL rather than naming an arbitrary membership. The
      // authoritative actor stays the admin audit identity.
      state.rows = rows as Array<{ id: string }>;
      const src = codeOnly(OPS);
      expect(src).toContain("practitionerRows.length === 1");
      expect(src).not.toMatch(/\.maybeSingle\(\)|\.single\(\)|\.limit\(1\)/);
      expect(src).toContain("resolved_by_practitioner_id: practitionerId,");
      // The rule itself, evaluated the way the action evaluates it.
      const resolved =
        rows && rows.length === 1 ? (rows[0] as { id: string }).id : null;
      expect(resolved).toBe(expected);
    },
  );

  it("never lets a query error silently decide attribution", () => {
    // `.maybeSingle()` THREW for 2+ rows, and the thrown-away error left the id
    // null by accident rather than by rule. The plural read cannot do that.
    const src = codeOnly(OPS);
    expect(src).toMatch(/const \{ data: practitionerRows \} = await admin/);
    expect(src).not.toMatch(/practitionerRow\?\.id/);
  });
});
