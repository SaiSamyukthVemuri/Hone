import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0323 — launch controls. Behaviour is proved against a real database in
// tests/db/waitlist-launch-controls.db.test.ts. This file pins the rollback file.

const root = join(__dirname, "..", "..");
const DOWN = readFileSync(join(root, "supabase/rollbacks/0323_waitlist_launch_controls.down.sql"), "utf8");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const FN = "public.count_competing_waitlist_invitations(uuid, date, date, integer[])";
const MARKER = "public.waitlist_closed_invited_booking_enabled()";

describe("0323 — rollback", () => {
  it("restores the 0204 matrix byte for byte and drops the new functions, inside its own transaction", () => {
    const d = exec(DOWN).trim();
    const body = (sql: string) => sql.match(/create or replace function public\.assert_new_client_admission\([\s\S]*?\n\$\$;/)![0];
    expect(body(d)).toBe(body(exec(readFileSync(join(root, "supabase/migrations/0204_new_client_admission_mode.sql"), "utf8"))));
    expect(d).toContain(`drop function if exists ${MARKER};`);
    expect(d).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(d).toContain(`drop function if exists ${FN};`);
    expect(d.endsWith("commit;")).toBe(true);
    expect(d).not.toMatch(/drop table/i);
  });
});
