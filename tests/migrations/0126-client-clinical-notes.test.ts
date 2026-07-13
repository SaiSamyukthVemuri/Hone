import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Static (SQL-text) proof of migration 0126 — Willow PR A: dedicated dated
// CONSULTATION notes + SKIN/HAIR ANALYSIS clinical records (client_clinical_notes).
// The behavioural proof (RLS, append-only, studio-derive, revision/concurrency,
// cross-studio denial) is in tests/db/client-clinical-notes.db.test.ts; this pins
// the deliberate contract in the SQL and carries the repo migration-max tripwire.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(MIG_DIR);
const FILE = FILES.find((f) => f.startsWith("0126_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";

describe("0126 — file + repo-max tripwire", () => {
  it("is the single 0126 migration with a purpose-encoding filename", () => {
    expect(FILE).toBeTruthy();
    expect(FILE).toMatch(/^0126_client_clinical_notes\.sql$/);
  });

  it("0125 exists immediately before it (0126 builds on the applied 0125 head)", () => {
    expect(FILES.some((f) => f.startsWith("0125_"))).toBe(true);
  });

  it("is present; the repo-max tripwire now lives in the 0127 test", () => {
    // 0127 (the author-INSERT policy fix) now advances the repo max; nothing
    // above 0127 may exist yet. The absolute repo-max pin lives in the 0127 test.
    expect(FILES.some((f) => f.startsWith("0126_"))).toBe(true);
    const higher = FILES.filter((f) => /^01(3[0-9]|[4-9]\d)_/.test(f));
    expect(higher).toEqual([]);
  });
});

describe("0126 — table shape + constraints", () => {
  it("creates public.client_clinical_notes with the exact 10 columns", () => {
    expect(SQL).toMatch(/create table if not exists public\.client_clinical_notes/);
    for (const col of [
      "id",
      "client_id",
      "studio_id",
      "practitioner_id",
      "kind",
      "body",
      "areas",
      "occurred_at",
      "supersedes_note_id",
      "created_at",
    ]) {
      expect(SQL).toMatch(new RegExp(`\\n\\s+${col}\\b`));
    }
  });

  it("kind is a two-value CHECK (consultation | skin_hair_analysis)", () => {
    expect(SQL).toMatch(
      /kind\s+text not null\s*\n?\s*check \(kind in \('consultation', 'skin_hair_analysis'\)\)/,
    );
  });

  it("body is non-empty by CHECK (trimmed length > 0)", () => {
    expect(SQL).toMatch(
      /constraint client_clinical_notes_body_nonempty check \(length\(btrim\(body\)\) > 0\)/,
    );
  });

  it("areas defaults to an empty text[] and is NOT NULL", () => {
    expect(SQL).toMatch(/areas\s+text\[\] not null default '\{\}'::text\[\]/);
  });

  it("occurred_at + created_at are timestamptz default now()", () => {
    expect(SQL).toMatch(/occurred_at\s+timestamptz not null default now\(\)/);
    expect(SQL).toMatch(/created_at\s+timestamptz not null default now\(\)/);
  });
});

describe("0126 — same-studio composite FKs + supersedes contract", () => {
  it("client + practitioner FKs are same-studio composite and CASCADE", () => {
    expect(SQL).toMatch(
      /foreign key \(client_id, studio_id\)\s*\n?\s*references public\.clients \(id, studio_id\) on delete cascade/,
    );
    expect(SQL).toMatch(
      /foreign key \(practitioner_id, studio_id\)\s*\n?\s*references public\.practitioners \(id, studio_id\) on delete cascade/,
    );
  });

  it("supersedes_note_id is a self-FK ON DELETE SET NULL (history is never orphaned)", () => {
    expect(SQL).toMatch(
      /foreign key \(supersedes_note_id\)\s*\n?\s*references public\.client_clinical_notes \(id\) on delete set null/,
    );
  });

  it("a partial unique index enforces one revision per note (optimistic concurrency)", () => {
    expect(SQL).toMatch(
      /create unique index if not exists client_clinical_notes_supersedes_uniq\s*\n?\s*on public\.client_clinical_notes \(supersedes_note_id\)\s*\n?\s*where supersedes_note_id is not null/,
    );
  });

  it("indexes the latest-by-kind + client + practitioner read paths", () => {
    expect(SQL).toMatch(/client_clinical_notes_latest_idx[\s\S]{0,120}\(studio_id, client_id, kind, occurred_at desc, created_at desc\)/);
    expect(SQL).toMatch(/client_clinical_notes_client_idx[\s\S]{0,80}\(client_id\)/);
    expect(SQL).toMatch(/client_clinical_notes_practitioner_idx[\s\S]{0,80}\(practitioner_id\)/);
  });
});

describe("0126 — triggers: studio-derive + append-only", () => {
  it("BEFORE INSERT derives studio_id from the parent client and validates a revision's parentage", () => {
    expect(SQL).toMatch(/function public\.client_clinical_notes_before_insert\(\)/);
    expect(SQL).toMatch(/select studio_id into v_studio from public\.clients where id = new\.client_id/);
    expect(SQL).toMatch(/new\.studio_id := v_studio/);
    expect(SQL).toMatch(/v_super\.client_id <> new\.client_id[\s\S]{0,80}v_super\.kind <> new\.kind/);
    expect(SQL).toMatch(/before insert on public\.client_clinical_notes/);
  });

  it("BEFORE UPDATE hard-blocks any in-place edit (append-only for every role)", () => {
    expect(SQL).toMatch(/function public\.client_clinical_notes_no_update\(\)/);
    expect(SQL).toMatch(/append-only; record a revision/);
    expect(SQL).toMatch(/before update on public\.client_clinical_notes/);
  });

  it("both trigger functions pin search_path = pg_catalog, pg_temp", () => {
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("0126 — RLS + grants (practitioner-only, no portal/public)", () => {
  it("enables RLS and defines member-SELECT + author-INSERT policies", () => {
    expect(SQL).toMatch(/alter table public\.client_clinical_notes enable row level security/);
    expect(SQL).toMatch(/for select to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)/);
    expect(SQL).toMatch(/for insert to authenticated\s*\n?\s*with check \([\s\S]{0,400}p\.user_id = \(select auth\.uid\(\)\)[\s\S]{0,40}p\.active/);
  });

  it("grants authenticated SELECT+INSERT only; UPDATE/DELETE/TRUNCATE revoked", () => {
    expect(SQL).toMatch(/grant select, insert on public\.client_clinical_notes to authenticated/);
    expect(SQL).toMatch(/revoke update, delete, truncate on public\.client_clinical_notes from authenticated/);
  });

  it("revokes everything from anon and grants only SELECT+INSERT to service_role", () => {
    expect(SQL).toMatch(/revoke all on public\.client_clinical_notes from anon/);
    expect(SQL).toMatch(/grant select, insert on public\.client_clinical_notes to service_role/);
    // NO update/delete policy exists (append-only); no portal/public role grants.
    expect(SQL).not.toMatch(/for update to authenticated/);
    expect(SQL).not.toMatch(/for delete to authenticated/);
    expect(SQL).not.toMatch(/to (portal|public_booking|web_anon)/i);
  });
});

describe("0126 — non-destructive: additive only, no backfill", () => {
  it("does not migrate/copy/reinterpret existing note sources (no backfill)", () => {
    expect(SQL).not.toMatch(/insert into public\.client_clinical_notes[\s\S]{0,200}select/i);
    for (const src of [
      "clients",
      "client_personal_notes",
      "sessions",
      "client_intake_forms",
      "electrolysis_entries",
    ]) {
      expect(SQL).not.toMatch(new RegExp(`update public\\.${src}\\b`, "i"));
    }
  });

  it("touches no clinical finalization/correction flags and drops nothing", () => {
    expect(SQL).not.toMatch(/clinical_finalization_enabled|clinical_corrections_enabled/i);
    expect(SQL).not.toMatch(/drop table|drop column/i);
  });
});
