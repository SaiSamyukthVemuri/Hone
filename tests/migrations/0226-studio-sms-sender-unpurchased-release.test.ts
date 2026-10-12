import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// Migration 0226 (SMS-SENDER-CONTROL-01, #863): release a never-purchased,
// never-activated errored sender claim. SOURCE CONTRACT; behaviour is proved
// in tests/db/sms-sender-controls.db.test.ts.

const VERSION = "0226";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0226_studio_sms_sender_unpurchased_release.sql");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const FNS = [
  ["get_releasable_studio_sms_claim", "uuid, uuid"],
  ["release_unpurchased_studio_sms_claim", "uuid, uuid, uuid, text"],
  ["studio_sms_resource_recorded", "uuid, text, text"],
] as const;
const body = (fn: string) => {
  const start = CODE.indexOf(`create or replace function public.${fn}(`);
  return CODE.slice(start, CODE.indexOf("$$;", CODE.indexOf("as $$", start) + 5));
};

describe("0226 in the sequence", () => {
  it("is the repository maximum on this branch, allocated once", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
    expect(countVersion(VERSION)).toBe(1);
  });

  it("leaves 0191, whose lifecycle it relies on, byte-identical", () => {
    // Pinned to the applied production bytes.
    const sha = createHash("sha256").update(read("0191_studio_sms_sender_provisioning.sql"), "utf8").digest("hex");
    expect(sha).toBe("8ff0c543fd81d02f5dc4e33756510481ce445af3271f487754ddd64a28a06704");
  });
});

describe("blast radius", () => {
  it("one transaction; three functions; no table, no ALTER, no DROP, no row written at top level", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
    expect([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])).toEqual(FNS.map(([f]) => f));
    expect(TOP_LEVEL).not.toMatch(/\b(create table|alter |drop )/i);
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert|update|delete)\b/im);
  });

  it("every function is security definer with a pinned search_path, revoked by name, granted to service_role only", () => {
    for (const [fn, args] of FNS) {
      expect(body(fn), fn).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL, `${fn} ${role}`).toContain(`revoke execute on function public.${fn}(${args}) from ${role};`);
      }
      const grants = [...TOP_LEVEL.matchAll(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (\\w+);`, "g"))].map((m) => m[1]);
      expect(grants, fn).toEqual(["service_role"]);
    }
  });
});

describe("only a claim that provably owns nothing is released", () => {
  const RELEASE = body("release_unpurchased_studio_sms_claim");

  it("the owner is derived from the actor, never trusted", () => {
    for (const fn of ["get_releasable_studio_sms_claim", "release_unpurchased_studio_sms_claim"]) {
      expect(body(fn), fn).toMatch(/where p\.studio_id = p_studio_id and p\.user_id = p_actor_user_id and p\.active = true/);
      expect(body(fn), fn).toMatch(/v_role <> 'owner'/);
    }
  });

  it("compare-and-set on the sender and its key, under the row lock", () => {
    expect(RELEASE).toMatch(/for update;/);
    expect(RELEASE).toMatch(/v_row\.id <> p_expected_sender_id\s+or v_row\.provisioning_claim_key is distinct from p_claim_key/);
  });

  it("error only, no recorded resource, and only the two definitive pre-purchase codes", () => {
    for (const fn of ["get_releasable_studio_sms_claim", "release_unpurchased_studio_sms_claim"]) {
      const b = body(fn);
      for (const col of ["phone_number", "phone_number_sid", "messaging_service_sid", "provisioned_at"]) {
        expect(b, `${fn} ${col}`).toMatch(new RegExp(`v_row\\.${col} is not null`));
      }
      expect(b, fn).toMatch(/v_row\.status <> 'error'/);
      expect(b, fn).toMatch(/not in \('number_no_longer_available', 'provider_resource_mismatch'\)/);
    }
  });

  it("goes error -> releasing -> released through 0191's guard, and nothing else", () => {
    expect(RELEASE).toMatch(/set status = 'releasing' where id = v_row\.id;\s+update public\.studio_sms_senders\s+set status = 'released', released_at = now\(\)/);
    expect(RELEASE.match(/update public\.studio_sms_senders/g)).toHaveLength(2);
  });
});
