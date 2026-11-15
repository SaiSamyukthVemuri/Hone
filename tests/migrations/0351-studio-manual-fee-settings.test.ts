import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

// 0351: STATIC contract only. Behaviour is proved against a real database in tests/db/studio-manual-fee-settings.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0351_studio_manual_fee_settings";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0351: shape", () => {
  it("consumes exactly one number and is the current maximum", () => {
    expect(countVersion("0351")).toBe(1);
    expect(isRepoMax("0351")).toBe(true);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });
  it("adds exactly two boolean NOT NULL DEFAULT false columns to studios, and nothing else", () => {
    expect(E.match(/add column if not exists/g)?.length).toBe(2);
    expect(E).toMatch(/late_cancel_fee_enabled boolean not null default false/);
    expect(E).toMatch(/no_show_fee_enabled boolean not null default false/);
    expect(E).not.toMatch(/create (or replace )?function|create policy|drop policy|\bgrant\b|\brevoke\b|\b(insert into|update public|delete from)\b/);
  });
  it("rollback drops exactly those two columns", () => {
    expect(DOWN).toMatch(/drop column if exists late_cancel_fee_enabled/);
    expect(DOWN).toMatch(/drop column if exists no_show_fee_enabled/);
    expect(DOWN.match(/drop column/g)?.length).toBe(2);
  });
});
