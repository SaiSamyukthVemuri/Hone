import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0154_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");

describe("0154 — practitioner_notifications.dedupe_key (additive, partial-unique, no backfill)", () => {
  it("is present and 0153 precedes it; nothing 0155+ yet", () => {
    expect(FILE).toMatch(/^0154_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0153_"))).toBe(true);
    expect(files.filter((f) => /^01(5[6-9]|[6-9]\d)_/.test(f))).toEqual([]);
  });

  it("adds a NULLABLE dedupe_key column (additive, no NOT NULL, no default)", () => {
    expect(SQL).toMatch(
      /add column if not exists dedupe_key text\s*;/i,
    );
    // Must NOT force NOT NULL or a default (would rewrite / constrain existing rows).
    expect(SQL).not.toMatch(/dedupe_key text[^;]*not null/i);
    expect(SQL).not.toMatch(/dedupe_key[^;]*set default/i);
    expect(SQL).not.toMatch(/alter column dedupe_key set not null/i);
  });

  it("bounds the key length with a CHECK", () => {
    expect(SQL).toMatch(
      /check \(dedupe_key is null or char_length\(dedupe_key\) <= \d+\)/i,
    );
  });

  it("creates a PARTIAL UNIQUE index on (studio_id, dedupe_key) where not null", () => {
    expect(SQL).toMatch(
      /create unique index if not exists \S+\s+on public\.practitioner_notifications \(studio_id, dedupe_key\)\s+where dedupe_key is not null/i,
    );
  });

  it("performs NO backfill and rewrites NO existing rows", () => {
    // No UPDATE/INSERT of existing notification rows, and no backfill of the
    // new column onto historical rows.
    expect(SQL).not.toMatch(/update public\.practitioner_notifications/i);
    expect(SQL).not.toMatch(/insert into public\.practitioner_notifications/i);
    expect(SQL).not.toMatch(/set dedupe_key =/i);
  });

  it("does NOT weaken RLS or touch policies / other tables", () => {
    expect(SQL).not.toMatch(/disable row level security/i);
    expect(SQL).not.toMatch(/drop policy/i);
    expect(SQL).not.toMatch(/create policy/i);
    expect(SQL).not.toMatch(/alter policy/i);
    // Only practitioner_notifications is touched.
    const otherTableWrite =
      /(alter table|create index|create unique index)[^;]*\bpublic\.(?!practitioner_notifications)\w+/i;
    expect(SQL).not.toMatch(otherTableWrite);
  });

  it("scopes the ALTERs to practitioner_notifications only", () => {
    const alters = SQL.match(/alter table public\.\w+/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toBe("alter table public.practitioner_notifications");
    }
  });
});
