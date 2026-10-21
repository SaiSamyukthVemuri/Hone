import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0230 (SMS-STOP-PREFLIGHT-RECORD-01, HON-50 G6): content rules, checked on
// the SQL itself. Behaviour is proved against a database in
// tests/db/studio-sms-stop-preflights.db.test.ts.
//
// 0230 REPLACES 0229's body of get_live_studio_sms_sender_registration_state.
// It must stay a superset: 0229's body exactly, plus one key.

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0230_studio_sms_sender_stop_preflights.sql");
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const RECORD =
  "public.record_studio_sms_stop_preflight(uuid, uuid, text, text, jsonb, smallint, text, text, timestamptz, text, timestamptz)";
const SNAPSHOT = "public.get_live_studio_sms_sender_registration_state(uuid)";

const snapshotBody = (src: string) => {
  const start = src.indexOf("create or replace function public.get_live_studio_sms_sender_registration_state(");
  return src.slice(start, src.indexOf("$$;", start) + 3);
};
const keys = (src: string) => new Set([...snapshotBody(src).matchAll(/'([a-z_]+)',/g)].map((m) => m[1]));

describe("0230 in the sequence", () => {
  it("is allocated once", () => {
    expect(countVersion("0230")).toBe(1);
  });
});

describe("0230 transaction and privileges (the 0217/0229 precedent)", () => {
  it("opens its own transaction with a local lock timeout", () => {
    expect(TOP_LEVEL).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/m);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("revokes EXECUTE on each function from public, anon, authenticated AND service_role by name, then grants service_role only", () => {
    for (const fn of [RECORD, SNAPSHOT]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL, `${fn} ${role}`).toContain(`revoke execute on function ${fn} from ${role};`);
      }
      const grants = TOP_LEVEL.match(new RegExp(`grant execute on function ${fn.replace(/[()]/g, "\\$&")} to (\\w+);`, "g")) ?? [];
      expect(grants, fn).toEqual([`grant execute on function ${fn} to service_role;`]);
    }
  });

  it("revokes all on the table from every role, grants it to none, and enables RLS", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all on table public.studio_sms_sender_stop_preflights from ${role};`);
    }
    expect(TOP_LEVEL).not.toMatch(/grant [^;]* on table public\.studio_sms_sender_stop_preflights/);
    expect(TOP_LEVEL).toContain("alter table public.studio_sms_sender_stop_preflights enable row level security;");
  });

  it("every definer pins its search_path", () => {
    const definers = CODE.match(/security definer\s*\n\s*set search_path = pg_catalog, pg_temp/g) ?? [];
    expect(definers).toHaveLength((CODE.match(/security definer/g) ?? []).length);
    expect(definers).toHaveLength(2);
  });
});

describe("0230 keeps the 0229 snapshot's contract (it replaces 0229's function body)", () => {
  it("is 0229's body EXACTLY plus the one added key", () => {
    const before = snapshotBody(read("0229_studio_sms_sender_campaign_bindings.sql"));
    const after = snapshotBody(SQL);
    // Remove 0230's single added block; what remains must be 0229 verbatim.
    const added = after.slice(after.indexOf("    -- 0230 (HON-50 G6)"), after.indexOf("  );\n$$;"));
    expect(added).toContain("'stop_preflights'");
    const restored = after.replace(added, "").replace("'[]'::jsonb),\n  );", "'[]'::jsonb)\n  );");
    expect(restored).toBe(before);
  });

  it("every 0229 key (and so every 0217 key) is still built; only stop_preflights and its row keys are added", () => {
    const before = keys(read("0229_studio_sms_sender_campaign_bindings.sql"));
    const after = keys(SQL);
    for (const k of before) expect(after.has(k), k).toBe(true);
    expect(before.has("provisioned_at")).toBe(true);
    expect(before.has("campaign_bindings")).toBe(true);
    expect([...after].filter((k) => !before.has(k)).sort()).toEqual([
      "checklist_version",
      "checks",
      "credentials_epoch",
      "ready",
      "stop_preflights",
      "webhook_base",
    ]);
  });
});

describe("0230 stores no secret and no free text", () => {
  it("no column or parameter names a token, secret, signature or detail", () => {
    const table = CODE.slice(CODE.indexOf("create table public.studio_sms_sender_stop_preflights"), CODE.indexOf("create index"));
    expect(table).not.toMatch(/token|secret|signature|detail|fingerprint|auth/i);
  });

  it("each recorded check is exactly { id, status }, and ready is derived by the writer, never passed in", () => {
    expect(CODE).toMatch(/\(select count\(\*\) from jsonb_object_keys\(c\)\) <> 2/);
    expect(CODE).toMatch(/\(c ->> 'status'\) not in \('pass', 'fail', 'unknown'\)/);
    expect(RECORD).not.toMatch(/boolean/);
    expect(CODE).toMatch(/v_ready := not exists \(/);
  });

  it("only the COMPLETE version-1 checklist is accepted (Codex P1 4304864063); the list itself is pinned to TS in stop-preflight-checklist-contract", () => {
    expect(CODE).toMatch(/p_checklist_version is null or p_checklist_version <> 1/);
    expect(CODE).toMatch(/jsonb_array_length\(p_checks\) <> cardinality\(v_checklist_v1\)/);
    expect(CODE).toMatch(/select 1 from unnest\(v_checklist_v1\) req/);
    expect(CODE).toMatch(/count\(distinct c ->> 'id'\)/);
    expect(TOP_LEVEL).toMatch(/check \(checklist_version = 1\)/);
  });

  it("the webhook base is an https URL with no query, fragment or userinfo", () => {
    const re = /webhook_base ~ '\^https:\/\/\[A-Za-z0-9\.-\]\+/;
    expect(CODE).toMatch(re);
  });

  it("the writer compare-and-sets on the checked_at the caller read (the 0229 pattern)", () => {
    expect(CODE).toMatch(/if v_current is distinct from p_expected_checked_at then\s*return query select 'preflight_changed'/);
    expect(CODE).toMatch(/for update;/);
  });
});
