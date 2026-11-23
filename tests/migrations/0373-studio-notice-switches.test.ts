import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax } from "./helpers/migration-state";
import { STUDIO_SETTINGS } from "@/lib/studio/settings";

// 0373: source contract for the two client-notice switches. Behaviour against a real database is in
// tests/db/studio-notice-switches.db.test.ts (needs a local stack at this head). Synthetic data only.

const root = join(__dirname, "..", "..");
const NAME = "0373_studio_notice_switches";
const strip = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const UP = strip(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = strip(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));
const COLUMNS = ["send_moved_appointment_emails", "send_client_cancellation_emails"] as const;

describe("0373 migration", () => {
  it("opens its own transaction with the lock timeout set INSIDE it, and commits", () => {
    expect(UP).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(UP.trim().endsWith("commit;")).toBe(true);
  });

  it.each(COLUMNS)("%s is a NOT NULL boolean defaulting to true, added idempotently", (c) => {
    expect(UP).toMatch(new RegExp(`add column if not exists ${c} boolean not null default true`));
  });

  it("adds exactly these two columns to studios and touches nothing else", () => {
    expect(UP.match(/alter table/g)).toHaveLength(1);
    expect(UP).toMatch(/alter table public\.studios/);
    expect(UP.match(/add column/g)).toHaveLength(2);
    for (const forbidden of [/\bgrant\b/, /\brevoke\b/, /create (or replace )?function/, /create policy/, /drop /, /\bupdate public\./, /\bdelete from\b/, /\binsert into\b/]) {
      expect(UP).not.toMatch(forbidden);
    }
  });

  it("never alters the booking-confirmation switch (it is only named in a column comment)", () => {
    const alter = UP.slice(UP.indexOf("alter table"), UP.indexOf(";", UP.indexOf("alter table")));
    expect(alter).not.toMatch(/send_confirmation_emails/);
    expect(UP).not.toMatch(/update public\.studios/);
  });

  it("documents each column", () => {
    for (const c of COLUMNS) expect(UP).toMatch(new RegExp(`comment on column public\\.studios\\.${c} is`));
  });

  it("the rollback drops exactly the two columns inside its own transaction", () => {
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    for (const c of COLUMNS) expect(DOWN).toMatch(new RegExp(`drop column if exists ${c}`));
    expect(DOWN.match(/drop column/g)).toHaveLength(2);
    expect(DOWN.trim().endsWith("commit;")).toBe(true);
  });

  it("registers both as send-time preferences defaulting ON, matching the migration default", () => {
    for (const c of COLUMNS) expect(STUDIO_SETTINGS[c]).toEqual({ default: true, kind: "preference", readAt: "send-time" });
  });

  it("is the repository's current maximum migration (only the current max may assert this)", () => {
    expect(isRepoMax("0373")).toBe(true);
  });
});
