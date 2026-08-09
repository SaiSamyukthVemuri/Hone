import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs module without types, imported the same way
// tests/ci/classify-changes.test.ts imports scripts/classify-changes.mjs.
import { buildProfileSql, FORBIDDEN_IDENTIFIERS, foldProfile, isCleanProfile, PROFILE_KEYS } from "../../../scripts/synthetic-mirror/profile.mjs";
// @ts-expect-error — see above
import { generateClients, syntheticClient, SAFE_NOTES } from "../../../scripts/synthetic-mirror/generator.mjs";

const ROOT = join(__dirname, "..", "..", "..");
const SOURCE_STUDIO = "38cb3a8b-0000-4000-8000-000000000001";
const TARGET_STUDIO = "9d37c51a-0000-4000-8000-000000000002";

const MIRROR_FILES = [
  "scripts/synthetic-mirror.mjs",
  "scripts/synthetic-mirror/config.mjs",
  "scripts/synthetic-mirror/generator.mjs",
  "scripts/synthetic-mirror/identity.mjs",
  "scripts/synthetic-mirror/plan.mjs",
  "scripts/synthetic-mirror/profile.mjs",
  "scripts/synthetic-mirror/writer.mjs",
  "scripts/synthetic-mirror/plan-schema.mjs",
  "scripts/synthetic-mirror/plan-digest.mjs",
  "scripts/synthetic-mirror/verify-plan.mjs",
  "scripts/synthetic-mirror/export.mjs",
];

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Executable code only: block comments, line comments and the
 * FORBIDDEN_IDENTIFIERS literal are stripped.
 *
 * Those greps must run against CODE, not prose. This file's own documentation
 * discusses payment ids and source studios at length precisely because the
 * design excludes them, and profile.mjs necessarily *names* every forbidden
 * column in order to ban it. Asserting over raw text would make the honest
 * explanation of a safety property look like a violation of it.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/export const FORBIDDEN_IDENTIFIERS[\s\S]*?\]\);/, " ")
    // plan-schema.mjs defines FORBIDDEN_PLAN_KEYS, so it necessarily NAMES
    // every term this grep bans. Strip the declaration for the same reason the
    // one above is stripped: the ban list is not a violation of itself.
    .replace(/export const FORBIDDEN_PLAN_KEYS[\s\S]*?\]\);/, " ");
}

describe("synthetic mirror — the source read is aggregate-only", () => {
  const sql = buildProfileSql(SOURCE_STUDIO);

  it("selects only counts — every projected expression is a count()", () => {
    // Strip the constant key labels ('clients_total' etc.) so what remains is
    // exactly the value expressions.
    const projections = sql
      .split("\n")
      .filter((l: string) => /^(select|union all select)/.test(l.trim()))
      .map((l: string) => l.replace(/^\s*(union all )?select\s+/, ""));

    expect(projections.length).toBeGreaterThan(0);
    for (const p of projections) {
      const valueExpr = p.replace(/^'[a-z_]+'( as k)?,\s*/, "");
      expect(valueExpr).toMatch(/^count\(/);
    }
  });

  it("never uses select *", () => {
    expect(sql).not.toMatch(/select\s+\*/i);
  });

  it("names no identifying or clinical column", () => {
    // `next_session_note` is the single permitted exception and is pinned by
    // its own test below: the gap count must ask whether a plan note EXISTS,
    // which is a predicate, not a projection.
    for (const forbidden of FORBIDDEN_IDENTIFIERS as string[]) {
      if (forbidden === "next_session_note") continue;
      expect(sql.includes(forbidden), `SQL must not mention "${forbidden}"`).toBe(false);
    }
  });

  it("touches next_session_note only as a NULL/length predicate, never as a projection", () => {
    // The gap count genuinely needs to know whether a plan note EXISTS. It must
    // never read the note itself.
    expect(sql).toContain("next_session_note is not null");
    expect(sql).toContain("length(btrim(next_session_note)) > 0");
    expect(sql).not.toMatch(/select[^\n]*next_session_note[^\n]*(as|,)/);
    expect(sql).not.toMatch(/count\(\s*next_session_note/);
  });

  it("uses client_id only inside count(distinct ...) — a cardinality, never an identity", () => {
    const occurrences = sql.match(/client_id/g) ?? [];
    const guarded = sql.match(/count\(distinct client_id\)/g) ?? [];
    expect(occurrences.length).toBe(guarded.length);
  });

  it("refuses a non-UUID studio id, so the statement can never carry SQL", () => {
    expect(() => buildProfileSql("'; drop table clients; --")).toThrow(TypeError);
  });

  it("folds only the closed key vocabulary — an unknown key is dropped", () => {
    const folded = foldProfile([
      { k: "clients_total", n: 50 },
      { k: "client_name", n: "Real Person" },
      { k: "email", n: "someone@example.org" },
    ]);
    expect(folded.clients_total).toBe(50);
    expect(Object.keys(folded).sort()).toEqual([...(PROFILE_KEYS as string[])].sort());
    expect(isCleanProfile(folded)).toBe(true);
    expect(JSON.stringify(folded)).not.toContain("Real Person");
    expect(JSON.stringify(folded)).not.toContain("someone@example.org");
  });

  it("a profile carries integers only — no strings can survive the fold", () => {
    const folded = foldProfile([{ k: "clients_total", n: "50; DROP" }]);
    expect(folded.clients_total).toBe(0);
    for (const v of Object.values(folded)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("synthetic mirror — generated people are wholly invented", () => {
  it("has no input channel from the source studio at all", () => {
    // The generator's only parameters are the TARGET studio id and an ordinal.
    // If it ever grew a source parameter, this is where it would be noticed.
    expect(codeOf("scripts/synthetic-mirror/generator.mjs")).not.toMatch(/source/i);
    expect(syntheticClient.length).toBe(3); // (studioId, ordinal, cohort)
  });

  it("emits NULL email and NULL phone for every client — the provider guarantee", () => {
    const clients = generateClients(TARGET_STUDIO, 120);
    expect(clients).toHaveLength(120);
    for (const c of clients) {
      expect(c.email).toBeNull();
      expect(c.phone).toBeNull();
      expect(c.address).toBeNull();
    }
  });

  it("never emits a routable email domain", () => {
    const blob = JSON.stringify(generateClients(TARGET_STUDIO, 120));
    for (const domain of ["gmail.com", "icloud.com", "hotmail.com", "outlook.com", "yahoo.com", "@"]) {
      expect(blob).not.toContain(domain);
    }
  });

  it("uses only the fixed safe clinical vocabulary", () => {
    const allowed = new Set(Object.values(SAFE_NOTES as Record<string, string>));
    for (const c of generateClients(TARGET_STUDIO, 60)) {
      expect(allowed.has(c.notes)).toBe(true);
    }
  });

  it("is deterministic — the same studio regenerates byte-identical people", () => {
    expect(generateClients(TARGET_STUDIO, 50)).toEqual(generateClients(TARGET_STUDIO, 50));
  });

  it("is studio-scoped — two studios never generate the same ids", () => {
    const a = generateClients(TARGET_STUDIO, 50).map((c: { id: string }) => c.id);
    const b = generateClients(SOURCE_STUDIO, 50).map((c: { id: string }) => c.id);
    expect(new Set([...a, ...b]).size).toBe(100);
  });

  it("growing the population is purely additive — existing people never change", () => {
    const before = generateClients(TARGET_STUDIO, 50);
    const after = generateClients(TARGET_STUDIO, 80);
    expect(after.slice(0, 50)).toEqual(before);
  });
});

describe("synthetic mirror — no source identity is retained anywhere", () => {
  it("no module stores, maps or persists a source client id", () => {
    for (const rel of MIRROR_FILES) {
      const src = codeOf(rel);
      // A mapping table/state file would have to name one of these.
      expect(src, `${rel} must not build a source->fake mapping`).not.toMatch(
        /sourceClientId|source_client_id|clientMap|idMap|mapping/i,
      );
      // The source studio is read through exactly one statement; no module may
      // select rows from it.
      expect(src).not.toMatch(/from\s+public\.clients[\s\S]{0,80}sourceStudio/i);
    }
  });

  it("the source is only ever reachable through the aggregate profile statement", () => {
    const cli = read("scripts/synthetic-mirror.mjs");
    const sourceUses = cli.match(/sourceStudioId/g) ?? [];
    // Config plumbing, the profile reads (dry-run + export-plan), the reset
    // refusal check and the verifier binding. The bound exists so a NEW use of
    // the source studio id has to be noticed and justified, not to freeze a
    // number — but every read of the source must still go through
    // buildProfileSql, which is asserted next.
    expect(sourceUses.length).toBeLessThanOrEqual(8);
    const sqlReads = cli.match(/dbRows\(\s*buildProfileSql\(config\.sourceStudioId\)\s*\)/g) ?? [];
    const anySourceSql = cli.match(/config\.sourceStudioId/g) ?? [];
    expect(sqlReads.length).toBeGreaterThan(0);
    // No statement may interpolate the source studio id except the aggregate one.
    expect(cli).not.toMatch(/`[^`]*\$\{q\(config\.sourceStudioId\)\}[^`]*`/);
    expect(anySourceSql.length).toBeGreaterThanOrEqual(sqlReads.length);
  });

  it("no mirror module reads a photo, token, payment or provider identifier", () => {
    for (const rel of MIRROR_FILES) {
      const src = codeOf(rel).toLowerCase();
      for (const forbidden of [
        "treatment_image", "storage.from", "payment_intent", "stripe_customer",
        "payment_method", "receipt_url", "cancellation_token", "google_event_id",
        "message_sid", "ip_address", "user_agent",
      ]) {
        expect(src.includes(forbidden), `${rel} must not mention ${forbidden}`).toBe(false);
      }
    }
  });
});
