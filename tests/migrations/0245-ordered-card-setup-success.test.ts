import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

describe("0245 — ordered successor closes the unordered boundary", () => {
  const ordered = readFileSync(join(process.cwd(), "supabase/migrations/0245_ordered_card_setup_success.sql"), "utf8");
  const body = ordered.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  it("uses nullable paired evidence with no adoption/default/backfill", () => {
    expect(countVersion("0245")).toBe(1);
    expect(isRepoMax("0245")).toBe(true);
    expect(body).toContain("stripe_setup_success_event_created bigint");
    expect(body).not.toMatch(/default\s+(?:now|0)|update[^;]*set[^;]*where[^;]*is null/i);
    expect(body).toContain("unknown_event_order");
  });
  it("retains removed history under the exact coarse 0180 lock before private insertion", () => {
    expect(body).toContain("p_studio_id::text || '|' || p_client_id::text || '|'");
    expect(body).toContain("case when p_stripe_livemode then 't' else 'f' end, 0");
    expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(body.indexOf("select c.* into v_existing"));
    expect(body).toContain("pg_catalog.max(c.stripe_setup_success_event_created)");
    expect(body).toContain("v_existing.status = 'active'");
    expect(body).toContain("ambiguous_event_order");
    expect(body).toContain("setup_success_evidence_conflict");
  });
  it("closes old service execute, grants only ordered service API, with transactional lock timeout", () => {
    expect(body).toMatch(/begin;[\s\S]*set local lock_timeout = '5s';/);
    expect(body).toMatch(/revoke execute on function public\.save_client_card_on_file\([\s\S]*?from public, anon, authenticated, service_role;/);
    expect(body).not.toMatch(/grant execute on function public\.save_client_card_on_file\(/);
    expect(body).toMatch(/grant execute on function public\.save_client_card_on_file_ordered\([\s\S]*?to service_role;/);
    expect(body.trim()).toMatch(/commit;$/);
    expect(body).toContain("create unique index client_payment_methods_setup_success_event_uniq");
  });
});
