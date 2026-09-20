import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// 0199 — BOUNDED SERVER-SIDE CANDIDATE SELECTION
//
// Three application-side repairs each moved the starvation boundary without
// removing it, and the last one made the cost unbounded: an estate-sized
// enumeration, one resolver RPC per studio per window, and every routable
// studio uuid in one PostgREST URL.
//
// The predicate "this appointment's studio can send" is a join, so it moved to
// the database. These prove the shape, the bounds, and — most importantly —
// that being SELECTED is still not permission to SEND.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../../..");
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations/0199_reminder_sms_candidate_selection.sql"),
  "utf8",
);
const ROUTE = readFileSync(
  path.join(ROOT, "app/api/cron/appointment-reminders/route.ts"),
  "utf8",
);
const SEND = readFileSync(path.join(ROOT, "lib/sms/send-appointment.ts"), "utf8");
const code = (s: string) =>
  s.replace(/--.*$/gm, " ").replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

describe("the migration is read-only and minimal", () => {
  it("creates functions only — no table, column, backfill or data write", () => {
    const c = code(SQL);
    // ONE alter table — the generated column that makes the SMS destination a
    // fact the database owns. No new table, and no DML of any kind.
    expect((c.match(/alter table/gi) ?? []).length).toBe(1);
    expect(c).not.toMatch(/create table|insert into|update |delete from|drop table/i);
    expect((c.match(/create or replace function/g) ?? []).length).toBe(4);
  });

  it("both functions are STABLE and declare no mutation", () => {
    const c = code(SQL);
    expect((c.match(/\bstable\b/g) ?? []).length).toBe(2);
    expect(c).not.toMatch(/\bvolatile\b/);
  });

  it("wraps itself in a transaction with a lock timeout", () => {
    // `supabase db push` does not wrap a file, so a bare SET LOCAL never arms.
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/set local lock_timeout/);
    expect(SQL).toMatch(/^commit;/m);
  });
});

describe("security model", () => {
  const fns = [
    "reminder_sms_candidates(text, timestamptz, timestamptz, timestamptz, uuid, integer, integer)",
    "reminder_sms_unroutable_studios(text, timestamptz, timestamptz, integer, integer)",
  ];

  it("revokes EXECUTE from all four roles BY NAME, then grants service_role only", () => {
    // The 0129 (anon) / 0164 (service_role) trap: Supabase grants to anon,
    // authenticated AND service_role at create time, and PostgreSQL to PUBLIC.
    for (const fn of fns) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(SQL, `${fn} revoke ${role}`).toContain(
          `revoke execute on function public.${fn} from ${role};`,
        );
      }
      expect(SQL).toContain(`grant execute on function public.${fn} to service_role;`);
      // No browser role may execute.
      expect(SQL).not.toContain(`grant execute on function public.${fn} to authenticated;`);
      expect(SQL).not.toContain(`grant execute on function public.${fn} to anon;`);
    }
  });

  it("pins search_path on every function", () => {
    expect((code(SQL).match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(4);
  });

  it("adds NO table privilege — studio_sms_senders stays closed", () => {
    expect(code(SQL)).not.toMatch(/grant [a-z, ]* on (table )?public\.studio_sms_senders/i);
    expect(code(SQL)).not.toMatch(/grant [a-z, ]* on (table )?public\.appointments/i);
  });

  it("returns NO sender or provider identifier", () => {
    const c = code(SQL);
    // The whole reason the resolver stays the final authority.
    expect(c).not.toContain("messaging_service_sid");
    expect(c).not.toContain("phone_number_sid");
    expect(c).not.toContain("claim_key");
  });

  it("uses a closed vocabulary, not a caller-supplied column name", () => {
    const c = code(SQL);
    expect(c).toMatch(/p_kind in \('24h', '2h'\)/);
    // No dynamic SQL to steer.
    expect(c).not.toMatch(/execute\s+format|quote_ident/i);
  });
});

describe("boundedness", () => {
  it("caps output regardless of what the caller asks for", () => {
    const c = code(SQL);
    expect((c.match(/limit least\(greatest\(coalesce\(p_limit, 50\), 1\), 200\)/g) ?? []).length).toBe(2);
  });

  it("orders by (starts_at, id) so the keyset is a TOTAL order", () => {
    expect(code(SQL)).toContain("order by a.starts_at asc, a.id asc");
  });

  it("uses a KEYSET predicate, never OFFSET", () => {
    const c = code(SQL);
    expect(c).toMatch(/p_after_starts_at is null/);
    expect(c).toMatch(/a\.starts_at = p_after_starts_at and a\.id > /);
    expect(c).not.toMatch(/\boffset\b/i);
  });

  it("semi-joins the sender table so a violated invariant cannot fan out", () => {
    // A join would duplicate an appointment if one-live-per-studio were ever
    // broken, silently inflating a page.
    const c = code(SQL);
    expect(c).toMatch(/and exists \(\s*select 1\s*from public\.studio_sms_senders/);
    expect(c).not.toMatch(/join public\.studio_sms_senders/);
  });
});

describe("the route no longer enumerates the estate", () => {
  const c = () => code(ROUTE);

  it("makes NO per-studio resolver loop", () => {
    expect(c()).not.toContain("resolveStudioSmsSender");
    expect(c()).not.toContain("toggledStudioIds");
  });

  it("carries NO studio-id list through a query URL", () => {
    expect(c()).not.toContain("onlyStudioIds");
    expect(c()).not.toMatch(/\.in\("studio_id"/);
  });

  it("asks the database for one bounded page", () => {
    const x = c();
    expect(x).toMatch(/admin\.rpc\(\s*"reminder_sms_candidates"/);
    expect(x).toContain("p_limit: opts.pageSize");
    expect(x).toContain("pageSize: REMINDER_PAGE_SIZE + 1");
  });

  it("hydrates only that page — the id list is bounded by the page", () => {
    const x = c();
    expect(x).toContain('.in("id", ids)');
    // ids come from the bounded RPC, never from an estate read.
    expect(x).toMatch(/const ids = \(\(picked \?\? \[\]\)/);
  });
});

describe("selection is NOT send authority", () => {
  it("the send law still re-resolves before claiming", () => {
    const s = code(SEND);
    const resolveAt = s.indexOf("resolveStudioSmsSender(args.admin, args.studio.id)");
    const claimAt = s.indexOf("claimSmsSend(args.admin");
    const sendAt = s.indexOf("sendSmsSafely({");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(resolveAt);
    expect(sendAt).toBeGreaterThan(claimAt);
  });

  it("the consent / STOP gate still precedes routing", () => {
    const s = code(SEND);
    expect(s.indexOf("passesConsentGate({")).toBeLessThan(
      s.indexOf("resolveStudioSmsSender(args.admin, args.studio.id)"),
    );
  });

  it("a refusal after selection still costs zero claim and zero provider", () => {
    const s = code(SEND);
    // The refusal returns BEFORE claimSmsSend, so nothing is consumed.
    const refuseAt = s.indexOf("if (!studioSenderAllowsSend(routed))");
    const claimAt = s.indexOf("claimSmsSend(args.admin");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(refuseAt);
  });

  it("the migration says so, in the function comment", () => {
    expect(SQL).toMatch(/CANDIDATE FILTER ONLY/);
    expect(SQL).toMatch(/does NOT authorise a send/);
  });
});

describe("excluded studios still reach the operator", () => {
  it("reads the filter's complement and alerts on it", () => {
    const x = code(ROUTE);
    expect(x).toMatch(/admin\.rpc\(\s*"reminder_sms_unroutable_studios"/);
    expect(x).toContain("logStudioRoutingRefusal({");
    expect(x).toContain("UNROUTABLE_ALERT_LIMIT");
  });

  it("alerts BEFORE any send work", () => {
    const x = code(ROUTE);
    const alertAt = x.indexOf("unroutableStudiosWithCandidates({");
    const pageAt = x.indexOf("loadRoutableCandidatePage({");
    expect(alertAt).toBeGreaterThan(-1);
    expect(pageAt).toBeGreaterThan(alertAt);
  });

  it("that read decides nothing — it is alerting only", () => {
    const x = code(ROUTE);
    // Its result feeds the logger and nothing else.
    expect(x).not.toMatch(/unroutableStudiosWithCandidates[^;]*onlyStudioIds/);
  });

  it("the complement is bounded like the page", () => {
    expect(code(SQL)).toMatch(/not exists \(\s*select 1\s*from public\.studio_sms_senders/);
    expect(code(ROUTE)).toContain("const UNROUTABLE_ALERT_LIMIT = 50;");
  });
});

describe("the rotation cursor is durable before the pass ends", () => {
  // COMMENT-STRIPPED. A negative control that commented the await out left
  // every assertion green, because `// await Promise.all(routingAlerts);`
  // still contains the string being searched for. Prose is not code.
  const ROUTE = code(
    readFileSync(
      path.join(ROOT, "app/api/cron/appointment-reminders/route.ts"),
      "utf8",
    ),
  );

  it("awaits the routing alert batch instead of detaching it", () => {
    // reminder_sms_unroutable_studios uses OPEN ops_alerts rows as its rotation
    // cursor. Fire-and-forget broke that: on a pass whose studios are ALL
    // unroutable there is no send work to keep the invocation alive, so a
    // serverless runtime may freeze it before the durable row lands. The cursor
    // then never advances and the same first 50 studios are selected forever --
    // the invisibility the complement exists to prevent.
    expect(ROUTE).toContain("await Promise.all(routingAlerts)");
    expect(ROUTE).toMatch(/routingAlerts\.push\(logStudioRoutingRefusal\(/);
    // The helper must hand back a promise for that await to mean anything.
    expect(ROUTE).toMatch(/}\): Promise<void> \{/);
    // And NO alert in this route may be detached: every one of them is either
    // a rotation cursor the next pass reads, or operator evidence that a pass
    // completed something less than it appears to have.
    expect(ROUTE).not.toContain("void (async () => {");
  });
});
