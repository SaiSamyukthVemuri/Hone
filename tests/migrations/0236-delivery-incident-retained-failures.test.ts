import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0236_delivery_incident_retained_failures.sql", "utf8");
describe("0236 owner retained-failure projection source contract (not DB execution)", () => {
  it("uses its OPS allocation exactly once", () => {
    expect(countVersion("0236")).toBe(1);
    expect(fileForVersion("0236")).toBe("0236_delivery_incident_retained_failures.sql");
  });
  it("atomically replaces only the existing RPC without CASCADE", () => {
    expect(sql).toMatch(/begin;[\s\S]*set local lock_timeout = '5s';/);
    expect(sql).toContain("drop function public.owner_delivery_incidents(uuid) restrict;");
    expect(sql.match(/create function /g)).toHaveLength(1);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(sql).not.toMatch(/\bcascade\b|create (table|index|policy)|insert into|update public|delete from/i);
  });
  it("preserves authorization, pinned search path and exact authenticated-only ACL", () => {
    expect(sql).toContain("auth.uid() is null or p_studio_id is null");
    expect(sql).toContain("not public.is_studio_owner(p_studio_id)");
    expect(sql).toContain("errcode = '42501'");
    expect(sql).toContain("security definer\nset search_path = pg_catalog, pg_temp");
    expect(sql).toContain("from public, anon, authenticated, service_role;");
    expect(sql.match(/grant execute[^;]+;/g)).toEqual([
      "grant execute on function public.owner_delivery_incidents(uuid) to authenticated;",
    ]);
  });
  it("bounds globally after deduplication and binds both ledgers and appointments to the studio", () => {
    expect(sql.match(/m.studio_id = d.studio_id/g)).toHaveLength(2);
    expect(sql.match(/a.id = m.appointment_id and a.studio_id = d.studio_id/g)).toHaveLength(2);
    expect(sql.match(/m.status = d.failure_class/g)).toHaveLength(2);
    expect(sql).toContain("distinct on (m.incident_id, m.appointment_id)");
    expect(sql).toContain("order by m.incident_id, m.appointment_id, m.claimed_at desc, m.message_id desc");
    expect(sql.match(/where d.channel = '(email|sms)' and d.resolved_at is null/g)).toHaveLength(2);
    expect(sql).toMatch(/from distinct_appointments m\s+order by m.claimed_at desc, m.message_id desc, m.incident_id desc\s+limit 200/);
    expect(sql).toContain("'last_reason', m.reason");
    expect(sql).toContain("order by m.claimed_at desc, m.message_id desc) as appointments");
    expect(sql).not.toMatch(/m.claimed_at\s*[<>]=?/);
    expect(sql).toContain("coalesce(p.appointments, '[]'::jsonb)");
  });
  it("leaves the previously proved 0215 migration byte-identical", () => {
    expect(createHash("sha256").update(readFileSync("supabase/migrations/0215_delivery_incidents.sql")).digest("hex"))
      .toBe("612f98fe62b9bb7113e32956a46eaeab07238fbf94cb305f6c1ab6ddaa2ec168");
  });
});
