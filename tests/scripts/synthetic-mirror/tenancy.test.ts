import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TODO_PRIORITY, type TodoKind } from "@/lib/dashboard/todo-model";

// @ts-expect-error — .mjs module without types
import { assertMutationAllowed, assertNotSource, assertOperatorOwnsTarget, configProblems, ENV, loadConfig, MirrorRefusal } from "../../../scripts/synthetic-mirror/config.mjs";
// @ts-expect-error — .mjs module without types
import { COHORTS } from "../../../scripts/synthetic-mirror/generator.mjs";

const ROOT = join(__dirname, "..", "..", "..");
const SOURCE = "38cb3a8b-0000-4000-8000-000000000001";
const TARGET = "9d37c51a-0000-4000-8000-000000000002";

/**
 * Executable code only, comments stripped.
 *
 * These greps must run against CODE. The mirror's documentation names Twilio,
 * `db execute` and `admin-server.ts` precisely to record that it does NOT use
 * them; matching raw text would turn each honest explanation into a failure and
 * push the next author toward deleting the explanation instead of keeping the
 * property.
 */
function codeOf(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const okEnv = {
  [ENV.enabled]: "true",
  [ENV.sourceStudioId]: SOURCE,
  [ENV.targetStudioId]: TARGET,
  [ENV.operatorEmail]: "operator@example.com",
};

const owners = [
  { studio_id: TARGET, role: "owner", active: true, email: "operator@example.com" },
];

describe("kill switch (Phase 18)", () => {
  it("defaults OFF when the variable is absent", () => {
    expect(loadConfig({}).enabled).toBe(false);
  });

  it("is OFF for anything other than the exact string 'true'", () => {
    for (const v of ["1", "TRUE", "yes", "on", "True", ""]) {
      expect(loadConfig({ [ENV.enabled]: v }).enabled).toBe(false);
    }
    expect(loadConfig({ [ENV.enabled]: "true" }).enabled).toBe(true);
  });

  it("refuses every mutating run while OFF, even with perfect configuration", () => {
    const config = loadConfig({ ...okEnv, [ENV.enabled]: "false" });
    expect(() => assertMutationAllowed(config)).toThrow(/kill switch is OFF/);
  });

  it("refuses rather than continuing partially when configuration is broken", () => {
    const config = loadConfig({ ...okEnv, [ENV.targetStudioId]: "not-a-uuid" });
    expect(() => assertMutationAllowed(config)).toThrow(MirrorRefusal);
  });
});

describe("tenancy — source and target are pinned server-side (Phase 10)", () => {
  it("refuses when source and target are the same studio", () => {
    const config = loadConfig({ ...okEnv, [ENV.targetStudioId]: SOURCE });
    expect(configProblems(config).join(" ")).toMatch(/SAME studio/);
    expect(() => assertMutationAllowed(config)).toThrow(MirrorRefusal);
  });

  it("refuses to treat the SOURCE studio as a write/delete target", () => {
    const config = loadConfig(okEnv);
    expect(() => assertNotSource(config, SOURCE)).toThrow(/strictly read-only/);
  });

  it("refuses a studio that is neither source nor the configured target", () => {
    const config = loadConfig(okEnv);
    expect(() => assertNotSource(config, "00000000-0000-4000-8000-000000000009")).toThrow(
      MirrorRefusal,
    );
  });

  it("accepts only the configured target", () => {
    expect(assertNotSource(loadConfig(okEnv), TARGET)).toBe(true);
  });

  it("takes source and target ONLY from the environment — never an argument", () => {
    const cli = readFileSync(join(ROOT, "scripts/synthetic-mirror.mjs"), "utf8");
    // Studio ids are read from config, which is built from process.env alone.
    expect(cli).toContain("loadConfig()");
    expect(cli).not.toMatch(/argv\[[12]\][\s\S]{0,40}studio/i);
    const config = readFileSync(join(ROOT, "scripts/synthetic-mirror/config.mjs"), "utf8");
    expect(config).toContain("env[ENV.sourceStudioId]");
    expect(config).toContain("env[ENV.targetStudioId]");
  });

  it("hard-codes no studio uuid and no operator identity in source", () => {
    for (const rel of [
      "scripts/synthetic-mirror.mjs",
      "scripts/synthetic-mirror/config.mjs",
      "scripts/synthetic-mirror/generator.mjs",
      "scripts/synthetic-mirror/identity.mjs",
      "scripts/synthetic-mirror/plan.mjs",
      "scripts/synthetic-mirror/profile.mjs",
      "scripts/synthetic-mirror/writer.mjs",
    ]) {
      // A real v4 uuid must not appear ANYWHERE, comments included.
      expect(readFileSync(join(ROOT, rel), "utf8")).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      );
      // An operator identity must not appear in code. (Prose may name the
      // source studio when explaining the design; an address may not.)
      expect(codeOf(rel)).not.toMatch(/samyukth|@gmail\.com/i);
    }
  });
});

describe("ownership guard — not keyed on a mutable string alone (Phase 11)", () => {
  it("accepts an operator holding an ACTIVE OWNER membership of the target", () => {
    expect(assertOperatorOwnsTarget(loadConfig(okEnv), owners)).toBe(true);
  });

  it("refuses an ordinary studio member", () => {
    const member = [{ ...owners[0], role: "practitioner" }];
    expect(() => assertOperatorOwnsTarget(loadConfig(okEnv), member)).toThrow(MirrorRefusal);
  });

  it("refuses a deactivated owner", () => {
    const inactive = [{ ...owners[0], active: false }];
    expect(() => assertOperatorOwnsTarget(loadConfig(okEnv), inactive)).toThrow(MirrorRefusal);
  });

  it("refuses an owner of a DIFFERENT studio, even with the right address", () => {
    const elsewhere = [{ ...owners[0], studio_id: "00000000-0000-4000-8000-00000000000a" }];
    expect(() => assertOperatorOwnsTarget(loadConfig(okEnv), elsewhere)).toThrow(MirrorRefusal);
  });

  it("refuses when no membership can be resolved at all", () => {
    expect(() => assertOperatorOwnsTarget(loadConfig(okEnv), [])).toThrow(MirrorRefusal);
    expect(() => assertOperatorOwnsTarget(loadConfig(okEnv), null)).toThrow(MirrorRefusal);
  });
});

describe("the mirror is invisible to the application (Phase 10)", () => {
  it("nothing under app/ or lib/ imports any mirror module", () => {
    const hits = execSync(
      `grep -rl "synthetic-mirror" app lib components 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    expect(hits).toBe("");
  });

  it("adds no route, server action or browser-reachable surface", () => {
    const hits = execSync(
      `grep -rln "use server\\|NextResponse\\|export async function GET\\|export async function POST" scripts/synthetic-mirror.mjs scripts/synthetic-mirror 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    expect(hits).toBe("");
  });

  it("weakens no RLS and ships no migration", () => {
    const changed = execSync(
      `git diff --name-only d3b326ec27c27bec19fffe87a980d47c01c98a96...HEAD 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(changed).not.toMatch(/supabase\/migrations\//);
    for (const rel of ["scripts/synthetic-mirror.mjs", "scripts/synthetic-mirror/writer.mjs"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/\bgrant\b|\brevoke\b|row level security|create policy|drop policy/i);
    }
  });

  it("adds no service-role call site to the application surface", () => {
    // tests/security/service-role-allowlist.test.ts scans app/ and lib/ only.
    // The mirror deliberately lives outside it and never imports admin-server.
    const cli = codeOf("scripts/synthetic-mirror.mjs");
    expect(cli).not.toContain("admin-server");
    expect(cli).not.toContain("createAdminClient");
  });
});

describe("provider side effects are structurally impossible", () => {
  const files = [
    "scripts/synthetic-mirror.mjs",
    "scripts/synthetic-mirror/config.mjs",
    "scripts/synthetic-mirror/generator.mjs",
    "scripts/synthetic-mirror/identity.mjs",
    "scripts/synthetic-mirror/plan.mjs",
    "scripts/synthetic-mirror/profile.mjs",
    "scripts/synthetic-mirror/writer.mjs",
  ].map((rel) => [rel, codeOf(rel)] as const);

  it("imports no email, SMS, Stripe, Google or webhook module", () => {
    // Checked against IMPORT SPECIFIERS, not free text: the safety report
    // legitimately prints the words "Twilio" and "Stripe" when telling the
    // operator those channels are inert.
    for (const [rel, src] of files) {
      const specifiers = [
        ...src.matchAll(/(?:^|\s)import\s[\s\S]*?from\s+["']([^"']+)["']/g),
        ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
        ...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1].toLowerCase());

      for (const spec of specifiers) {
        for (const forbidden of [
          "resend", "twilio", "stripe", "googleapis", "google-calendar",
          "send-appointment", "send-welcome", "postcare", "lib/email", "lib/sms",
        ]) {
          expect(spec.includes(forbidden), `${rel} must not import ${forbidden}`).toBe(false);
        }
      }
      // The ONLY third-party import the mirror is allowed to make.
      for (const spec of specifiers) {
        expect(
          spec.startsWith(".") || spec === "@supabase/supabase-js" || spec.startsWith("node:"),
          `${rel} imports unexpected module "${spec}"`,
        ).toBe(true);
      }
    }
  });

  it("performs no outbound network call of its own", () => {
    for (const [rel, src] of files) {
      // The only network egress is the Supabase client and the supabase CLI.
      expect(src, `${rel}`).not.toMatch(/\bfetch\(|axios|node-fetch|https?:\/\/(?!localhost)/);
    }
  });

  it("never writes to the source studio — no statement targets it", () => {
    const cli = readFileSync(join(ROOT, "scripts/synthetic-mirror.mjs"), "utf8");
    // Every mutating call is scoped by the TARGET studio id.
    for (const m of cli.match(/\.from\("[a-z_]+"\)[\s\S]{0,220}/g) ?? []) {
      if (!/\.upsert\(|\.delete\(/.test(m)) continue;
      expect(m).not.toContain("sourceStudioId");
    }
    expect(cli).not.toMatch(/upsert[\s\S]{0,120}sourceStudioId/);
  });

  it("performs NO database write of any kind — the strongest available guarantee", () => {
    // This PR is deliberately incapable of writing to production. Executing the
    // plan would need a direct INSERT into `sessions` / `appointments`, which
    // the repository forbids at zero (L18 Phase 4 + the appointment writer
    // census, both of which scan scripts/). Rather than exempt this tool, the
    // write path is left out until a governed one is agreed.
    const cli = codeOf("scripts/synthetic-mirror.mjs");
    for (const dml of [
      ".upsert(", ".insert(", ".delete()", ".update(",
      "insert into", "update ", "delete from", "truncate",
    ]) {
      expect(cli.toLowerCase().includes(dml.toLowerCase()), `CLI must not contain "${dml}"`).toBe(false);
    }
    // And no service-role client can be constructed to do it with.
    expect(cli).not.toMatch(/SERVICE_ROLE_KEY|createClient\(/);
  });

  it("keeps the reset SELECTION logic pure and provable, even with no deleter", () => {
    // The selection is what a future, governed reset would consume. It must
    // already be impossible for it to nominate a row it cannot re-derive.
    const cli = codeOf("scripts/synthetic-mirror.mjs");
    expect(cli).toContain("selectResettableIds");
    expect(cli).toContain("syntheticIdSet");
    expect(cli).not.toMatch(/where\s+studio_id\s*=[^)]*delete/i);
  });

  it("reads production through `db query` only — never `db execute` or `db push`", () => {
    const cli = codeOf("scripts/synthetic-mirror.mjs");
    expect(cli).toContain('"db", "query", "--linked"');
    expect(cli).not.toMatch(/db["\s,]+execute/);
    expect(cli).not.toMatch(/db["\s,]+push/);
    expect(cli).not.toMatch(/migration/i);
  });
});

describe("dashboard coverage — every To-do kind is accounted for", () => {
  // The mirror exists to exercise the dashboard, so a NEW TodoKind must not be
  // able to appear without someone deciding how the mirror covers it. This map
  // is the decision record; the test fails if a kind is added and left out.
  const COVERAGE: Record<TodoKind, "covered" | "deliberately-excluded"> = {
    intake_review: "covered",          // intake rows with status 'submitted'
    charting: "covered",               // completed appointment with no session
    aftercare: "covered",              // sessions with aftercare_..._at NULL
    probe_lot: "covered",              // sessions without a probe lot
    intake_incomplete: "covered",      // intake rows with status 'in_progress'
    follow_up: "covered",              // next_session_note + nothing booked
    treatment_memory: "covered",       // watch/plan/reaction on newest session
    records_details: "covered",        // clients with details left null
    supply_expiry: "deliberately-excluded",  // record-keeping fixtures are a follow-up
    payment_setup: "deliberately-excluded",  // studio-level; Stripe is LIVE in prod
    no_services: "deliberately-excluded",    // would break booking studio-wide
  };

  it("covers or explicitly excludes every kind in the shipping union", () => {
    const kinds = Object.keys(TODO_PRIORITY) as TodoKind[];
    for (const kind of kinds) {
      expect(COVERAGE[kind], `TodoKind "${kind}" has no mirror coverage decision`).toBeDefined();
    }
    expect(Object.keys(COVERAGE).sort()).toEqual([...kinds].sort());
  });

  it("covers the majority of kinds, so the To-do list renders multiple kinds", () => {
    const covered = Object.values(COVERAGE).filter((v) => v === "covered");
    expect(covered.length).toBeGreaterThanOrEqual(8);
  });

  it("has a client cohort for each covered client-level kind", () => {
    for (const cohort of [
      "intake_submitted", "intake_in_progress", "charting_gap",
      "aftercare_gap", "probe_gap", "follow_up", "long_history",
    ]) {
      expect(COHORTS as string[]).toContain(cohort);
    }
  });
});
