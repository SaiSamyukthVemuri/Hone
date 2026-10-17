import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0229 (SMS-CAMPAIGN-BINDING-01, HON-50 G4a): content rules ops01 set for the
// number, checked on the SQL itself. Behaviour is proved against a database
// in tests/db/studio-sms-campaign-bindings.db.test.ts.

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0229_studio_sms_sender_campaign_bindings.sql");
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const RECORD = "public.record_studio_sms_campaign_binding(uuid, uuid, text, text, text, text, text)";
const SNAPSHOT = "public.get_live_studio_sms_sender_registration_state(uuid)";

describe("0229 in the sequence", () => {
  it("is allocated once", () => {
    expect(countVersion("0229")).toBe(1);
  });
});

describe("0229 transaction and privileges", () => {
  it("opens its own transaction with a local lock timeout", () => {
    expect(TOP_LEVEL).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/m);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("revokes EXECUTE on each function from public, anon, authenticated AND service_role by name, then grants service_role only", () => {
    for (const fn of [RECORD, SNAPSHOT]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL, `${fn} ${role}`).toContain(`revoke execute on function ${fn} from ${role};`);
      }
      expect(TOP_LEVEL).toContain(`grant execute on function ${fn} to service_role;`);
      const grants = TOP_LEVEL.match(new RegExp(`grant execute on function ${fn.replace(/[()]/g, "\\$&")} to (\\w+);`, "g")) ?? [];
      expect(grants, fn).toHaveLength(1);
    }
  });

  it("revokes all on the table from every role and grants it to none", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all on table public.studio_sms_sender_campaign_bindings from ${role};`);
    }
    expect(TOP_LEVEL).not.toMatch(/grant [^;]* on table public\.studio_sms_sender_campaign_bindings/);
    expect(TOP_LEVEL).toContain("alter table public.studio_sms_sender_campaign_bindings enable row level security;");
  });

  it("every definer pins its search_path", () => {
    const definers = CODE.match(/security definer\s*\n\s*set search_path = pg_catalog, pg_temp/g) ?? [];
    expect(definers).toHaveLength((CODE.match(/security definer/g) ?? []).length);
    expect(definers).toHaveLength(2);
  });
});

describe("0229 keeps the 0217 snapshot's contract", () => {
  it("every 0217 key is still built, and only provisioned_at and campaign_bindings are added", () => {
    const body = (src: string) => {
      const start = src.indexOf("create or replace function public.get_live_studio_sms_sender_registration_state(");
      return src.slice(start, src.indexOf("$$;", start));
    };
    const keys = (src: string) => new Set([...body(src).matchAll(/'([a-z_]+)',/g)].map((m) => m[1]));
    const before = keys(read("0217_studio_sms_sender_registrations.sql"));
    const after = keys(SQL);
    for (const k of before) expect(after.has(k), k).toBe(true);
    expect([...after].filter((k) => !before.has(k)).sort()).toEqual([
      "campaign_bindings",
      "campaign_sid",
      "campaign_status",
      "checked_at",
      "provisioned_at",
      "verified_at",
    ]);
  });
});
