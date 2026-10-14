import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// 0227 — DELIVERY-QUARANTINE-BOUND-01 (Codex P2 4252980865 on #832).
//
// Source contract for the forward fix. The behaviour (a backlog larger than
// the limit, targeted receipts, competing sweeps) is proved against a real
// database in tests/db/email-receipt-quarantine-bound.db.test.ts.
// ===========================================================================

const FILE = "0227_email_receipt_quarantine_bound.sql";
const VERSION = "0227";
const DIR = path.join(process.cwd(), "supabase/migrations");
const SQL = readFileSync(path.join(DIR, FILE), "utf8");
const CODE = SQL.replace(/--[^\n]*/g, "");
const SIG = "public.claim_email_provider_events(uuid, integer)";

function fnBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.claim_email_provider_events(");
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", start));
}

describe("0227 is a forward fix, not an edit of the applied 0212", () => {
  it("leaves 0212's applied bytes unchanged", () => {
    const applied = readFileSync(path.join(DIR, "0212_email_delivery_events.sql"));
    expect(createHash("sha256").update(applied).digest("hex")).toBe(
      "cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1",
    );
  });

  it("opens its own transaction with a bounded lock wait", () => {
    expect(CODE).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/m);
    expect(CODE.trimEnd()).toMatch(/commit;$/);
  });

  it("redefines exactly two functions (the claim and the processor) and touches no table, policy or trigger", () => {
    expect(CODE.match(/create or replace function/g)).toHaveLength(2);
    expect(CODE).toContain("create or replace function public.claim_email_provider_events(");
    expect(CODE).toContain("create or replace function public.process_email_provider_event(");
    expect(CODE).not.toMatch(/\b(create|alter|drop)\s+(table|policy|trigger|index|type)\b/i);
    expect(CODE).not.toMatch(/\b(insert\s+into|delete\s+from|truncate)\b/i);
  });

  it("keeps the signature, return shape, definer rights and pinned search_path", () => {
    const body = fnBody(CODE);
    expect(body).toMatch(/claim_email_provider_events\(\s*p_event_id uuid,\s*p_limit\s+integer\s*\) returns table \(\s*receipt_id uuid\s*\)/);
    expect(body).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });

  it("differs from 0212's body only by bounding and ordering the quarantine step, and the claim tie-break", () => {
    const strip = (s: string) =>
      fnBody(s.replace(/--[^\n]*/g, ""))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const before = strip(readFileSync(path.join(DIR, "0212_email_delivery_events.sql"), "utf8"));
    const after = strip(CODE);
    // Multiset difference: "limit v_limit" already appears once in 0212.
    const minus = (a: string[], b: string[]) => {
      const left = [...b];
      return a.filter((l) => {
        const i = left.indexOf(l);
        if (i === -1) return true;
        left.splice(i, 1);
        return false;
      });
    };
    expect(minus(after, before).sort()).toEqual(
      ["limit v_limit", "order by e.received_at, e.id", "order by e.received_at, e.id"].sort(),
    );
    expect(minus(before, after)).toEqual(["order by e.received_at"]);
  });

  it("bounds the quarantine CTE by v_limit, oldest first, skipping locked rows", () => {
    const spent = CODE.slice(CODE.indexOf("with spent as ("), CODE.indexOf("update public.email_provider_events e"));
    expect(spent).toMatch(/order by e\.received_at, e\.id\s+limit v_limit\s+for update skip locked/);
  });

  it("keeps the five-attempt cap, the claim lease, the sweep age and the 1..50 clamp", () => {
    const body = fnBody(CODE);
    expect(body).toContain("c_max_attempts constant integer  := 5;");
    expect(body).toContain("c_claim_ttl    constant interval := interval '2 minutes';");
    expect(body).toContain("c_sweep_age    constant interval := interval '1 minute';");
    expect(body).toContain("else greatest(1, least(coalesce(p_limit, 10), 50))");
    expect(body).toContain("when p_event_id is not null then 1");
  });

  it("restates the grants by name: service_role only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${SIG} from ${role};`);
    }
    expect(CODE.match(/grant execute on function/g)).toHaveLength(2);
    expect(CODE).toContain(`grant execute on function ${SIG} to service_role;`);
    expect(CODE.lastIndexOf(`revoke execute on function ${SIG}`)).toBeLessThan(CODE.indexOf(`grant execute on function ${SIG}`));
  });
});

describe("0227 keeps Resend's transient bounces non-terminal (Codex P2 4265450918)", () => {
  const PSIG = "public.process_email_provider_event(uuid)";
  const procBody = (sql: string) => {
    const start = sql.indexOf("create or replace function public.process_email_provider_event(");
    expect(start).toBeGreaterThan(-1);
    return sql
      .slice(start, sql.indexOf("$$;", start))
      .replace(/--[^\n]*/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  };

  it("differs from 0212's processor ONLY by remapping a transient bounce to delivery_delayed", () => {
    const before = procBody(readFileSync(path.join(DIR, "0212_email_delivery_events.sql"), "utf8"));
    const after = procBody(SQL);
    const removed = before.filter((l, i, a) => a.slice(0, i + 1).filter((x) => x === l).length > after.filter((x) => x === l).length);
    const added = after.filter((l, i, a) => a.slice(0, i + 1).filter((x) => x === l).length > before.filter((x) => x === l).length);
    expect(removed).toEqual([]);
    expect(added).toEqual([
      "if v_target = 'bounced' and v_evt.bounce_type = 'transient' then",
      "v_target := 'delivery_delayed';",
      "end if;",
    ]);
  });

  it("puts the remap after the event-to-target mapping and before any ranking", () => {
    const body = SQL.slice(SQL.indexOf("create or replace function public.process_email_provider_event("));
    const mapEnd = body.indexOf("when 'email.complained'       then 'complained'");
    const remap = body.indexOf("if v_target = 'bounced' and v_evt.bounce_type = 'transient' then");
    const rank = body.indexOf("v_old_rank := case v_msg.status");
    expect(mapEnd).toBeGreaterThan(-1);
    expect(remap).toBeGreaterThan(mapEnd);
    expect(rank).toBeGreaterThan(remap);
  });

  it("restates the processor's grants by name: service_role only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${PSIG} from ${role};`);
    }
    expect(CODE).toContain(`grant execute on function ${PSIG} to service_role;`);
  });
});

describe("0227 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this
    // (CLAUDE.md §2). It moved here from 0212's test.
    expect(isRepoMax(VERSION), "0227 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0227 grants EXACTLY the intended roles, and nothing else", () => {
  // Every GRANT statement in the file -- any privilege, any object, every role
  // of a comma list -- as "privilege | object -> role". A stray grant beside
  // the intended one (to anon, a second role, \`grant all\`, a schema-wide
  // grant) changes this list, so the assertion is exact, not "contains".
  const grants = (code: string): string[] => {
    const out: string[] = [];
    for (const m of code.matchAll(/^\s*grant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;]+);/gim)) {
      const obj = m[2]!.replace(/\s+/g, " ").trim().replace(/^function /i, "");
      for (const role of m[3]!.split(",")) out.push(`${m[1]!.trim().toLowerCase()} | ${obj} -> ${role.trim().toLowerCase()}`);
    }
    return out.sort();
  };

  it("matches the intended grant list exactly", () => {
    expect(grants(CODE)).toEqual([
      "execute | public.claim_email_provider_events(uuid, integer) -> service_role",
      "execute | public.process_email_provider_event(uuid) -> service_role",
    ]);
  });
});
