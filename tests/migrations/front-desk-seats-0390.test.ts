import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0390: the per-studio Front Desk switch and admin-granted receptionist seats. SOURCE contract; the behaviour is proved on a real database by
// tests/db/front-desk-seats.db.test.ts.

const UP = readFileSync("supabase/migrations/0390_front_desk_rollout_and_seats.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0390_front_desk_rollout_and_seats.down.sql", "utf8");
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("0390 is shaped like a sealed migration", () => {
  it("is the repository's newest migration (this file is the current maximum's own test)", () => expect(isRepoMax("0390")).toBe(true));

  it("opens its own transaction and arms lock_timeout inside it, in the up and the down", () => {
    expect(UP).toMatch(/^begin;$/m);
    expect(UP).toMatch(/^commit;$/m);
    expect(UP.indexOf("begin;")).toBeLessThan(UP.indexOf("set local lock_timeout"));
    expect(DOWN).toMatch(/^begin;$/m);
    expect(DOWN).toMatch(/^commit;$/m);
  });

  it("fails closed: refuses unless each frozen body it replaces is exactly the one it was written against", () => {
    for (const fn of ["receptionist_actor_id", "set_studio_receptionist_active", "link_invited_membership"]) {
      expect(UP).toMatch(new RegExp(`md5\\(p\\.prosrc\\)[^\\n]*${fn}`));
    }
    expect(UP).toContain("31fb3186a227fd39470c4670e876935a");
  });

  it("starts empty: it seeds the front_desk key (the column default is off) and lists no studio and grants no seat", () => {
    expect(code(UP)).toMatch(/insert into public\.platform_rollouts \(key\) values \('front_desk'\)/);
    // The migration refuses to leave anything else behind: its own self-check, and no studio is ever inserted into the pilot list by it.
    expect(UP).toContain("0390 self-check: the front_desk key must exist in mode off with no studio and no seat");
    expect(code(UP)).not.toMatch(/insert into public\.platform_rollout_studios/);
  });

  it("can never enable the key for every studio: a table CHECK, not a function body", () => {
    expect(code(UP)).toMatch(/platform_rollouts_front_desk_mode_check[\s\S]*key <> 'front_desk'[\s\S]*mode in \('off', 'pilot'\)/);
  });

  it("revokes every new function from public, anon, authenticated AND service_role by name, then grants only what is intended", () => {
    expect(code(UP)).toMatch(/revoke all privileges on function public\.front_desk_seat_claim\(uuid, uuid, uuid\) from public, anon, authenticated, service_role/);
    expect(code(UP)).toMatch(/revoke all privileges on function public\.admin_grant_front_desk_seats\([^)]*\) from public, anon, authenticated, service_role/);
    expect(code(UP)).toMatch(/grant execute on function public\.front_desk_access\(\) to authenticated/);
    expect(code(UP)).toMatch(/grant execute on function public\.admin_revoke_front_desk_seats\(uuid, text, uuid, text\) to service_role/);
  });

  it("the seat reason never reaches the audit row", () => {
    const audit = code(UP).match(/insert into public\.admin_action_events[\s\S]*?\);/g) ?? [];
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) expect(a).not.toMatch(/p_reason|reason/);
  });

  it("the down refuses (55000) while a grant exists, a studio is listed or a replaced body is not the 0390 one", () => {
    expect(DOWN).toMatch(/errcode = '55000'/);
    expect(DOWN).toMatch(/seat grants exist/);
    expect(DOWN).toMatch(/front_desk key is in use/);
  });
});
