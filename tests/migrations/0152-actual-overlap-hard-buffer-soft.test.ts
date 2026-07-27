import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Static proof for migration 0152 (Chloe manual-override booking blocker).
// Contract (Option B): actual treatment overlap stays a HARD, never-bypassable
// GiST exclusion (23P01); the studios.buffer_minutes gap becomes a SOFT
// constraint enforced for every normal writer and bypassed ONLY by an
// authenticated internal OWNER override (booked_outside_availability = true).
// The migration is additive (no destructive DDL, no appointment-time rewrite),
// wrapped in a single transaction, and service_role-only for callable commands.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0152_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");

describe("0152 — file present + precedes nothing unexpected", () => {
  it("0152 exists and 0151 (RC hardening) immediately precedes it", () => {
    expect(FILE).toMatch(/^0152_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0151_"))).toBe(true);
    // The absolute repo-max pin lives in the 0131 test; this only guards
    // forward of the current chain (0153 colors + 0154 card-change dedupe now
    // present; trip on 0156+).
    expect(files.filter((f) => /^01(59|[6-9]\d)_/.test(f))).toEqual([]);
  });
});

describe("0152 — transactional + additive (non-destructive)", () => {
  it("is wrapped in a single begin/commit", () => {
    expect(SQL).toMatch(/^\s*begin;/m);
    expect(SQL).toMatch(/\ncommit;/);
  });

  it("adds booked_outside_availability as NOT NULL default false, idempotently", () => {
    expect(SQL).toMatch(
      /add column if not exists booked_outside_availability boolean not null default false/,
    );
  });

  it("rewrites no appointment START/END times and drops no table/column in the body", () => {
    // The only column drop lives in the ROLLBACK GUIDANCE comment block, never
    // in the executed body (which ends at the commit).
    const body = SQL.slice(0, SQL.indexOf("\ncommit;") + 1);
    expect(body).not.toMatch(/drop table/i);
    expect(body).not.toMatch(/drop column/i);
    // Strip $$-delimited function/DO bodies, leaving only apply-time statements.
    // The move_or_reassign function body legitimately UPDATEs appointment times
    // at runtime; the apply-time migration must not bulk-rewrite them. The only
    // apply-time bulk UPDATE targets the shadow (studio_calendar_reservations).
    const applyTime = body.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(applyTime).not.toMatch(/update\s+public\.appointments/i);
    expect(applyTime).toMatch(/update public\.studio_calendar_reservations r\s*\n\s*set ends_at = a\.ends_at/);
  });
});

describe("0152 — preflight refuses pre-existing actual overlaps", () => {
  it("counts confirmed/completed actual-interval overlaps and raises if any exist", () => {
    expect(SQL).toMatch(/0152 preflight failed/);
    // The preflight compares ACTUAL intervals (not blocked_ends_at).
    expect(SQL).toMatch(
      /tstzrange\(a1\.starts_at, a1\.ends_at, '\[\)'\)\s*\n?\s*&&\s*\n?\s*tstzrange\(a2\.starts_at, a2\.ends_at, '\[\)'\)/,
    );
  });
});

describe("0152 — HARD actual-overlap exclusions (both resource modes)", () => {
  it("studio-wide exclusion uses the ACTUAL interval, gated on capacity_enabled = false", () => {
    expect(SQL).toMatch(/add constraint no_overlapping_appointments_studio_wide/);
    expect(SQL).toMatch(
      /no_overlapping_appointments_studio_wide[\s\S]*?tstzrange\(starts_at, ends_at, '\[\)'\)[\s\S]*?where \(status = 'confirmed' and capacity_enabled = false\)/,
    );
  });

  it("per-practitioner exclusion uses the ACTUAL interval, gated on capacity_enabled = true", () => {
    expect(SQL).toMatch(/add constraint no_overlapping_appointments_per_practitioner/);
    expect(SQL).toMatch(
      /no_overlapping_appointments_per_practitioner[\s\S]*?tstzrange\(starts_at, ends_at, '\[\)'\)[\s\S]*?where \(status = 'confirmed' and capacity_enabled = true\)/,
    );
  });

  it("no exclusion is built on blocked_ends_at (the buffer-expanded basis is retired as HARD)", () => {
    // blocked_ends_at is RETAINED as a column (slot-gen/reporting) but must not
    // appear in any EXECUTABLE statement of 0152 — only in comments. Strip line
    // comments, then assert it is absent from the executable SQL.
    const executable = SQL.split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(executable).not.toMatch(/blocked_ends_at/);
  });
});

describe("0152 — shadow reservation mirrors the ACTUAL interval", () => {
  it("sync trigger inserts new.ends_at (not blocked_ends_at) and rematerializes existing rows", () => {
    expect(SQL).toMatch(/create or replace function public\.sync_appointment_to_calendar_reservation/);
    expect(SQL).toMatch(/new\.starts_at, new\.ends_at\)\s*(--[^\n]*)?\s*\n/);
    expect(SQL).toMatch(
      /update public\.studio_calendar_reservations r\s*\n\s*set ends_at = a\.ends_at/,
    );
  });
});

describe("0152 — SOFT buffer helper is buffer-proximity minus true overlap", () => {
  it("appointment_buffer_conflict is buffer windows overlap AND NOT actual overlap", () => {
    expect(SQL).toMatch(/create or replace function public\.appointment_buffer_conflict/);
    // buffer-expanded windows overlap ...
    expect(SQL).toMatch(/make_interval\(mins => cfg\.buf\)/);
    // ... but the actual intervals do NOT (true overlap is the GiST's job).
    expect(SQL).toMatch(
      /and not \(\s*\n\s*tstzrange\(p_starts_at, p_ends_at, '\[\)'\)\s*\n?\s*&&\s*\n?\s*tstzrange\(a\.starts_at, a\.ends_at, '\[\)'\)/,
    );
  });
});

describe("0152 — uniform SOFT-buffer trigger over EVERY writer", () => {
  it("raises HB001, skips rows flagged booked_outside_availability, and fires before insert/update", () => {
    expect(SQL).toMatch(/create or replace function public\.enforce_appointment_buffer/);
    expect(SQL).toMatch(/raise exception 'appointment_buffer_conflict' using errcode = 'HB001'/);
    expect(SQL).toMatch(/coalesce\(new\.booked_outside_availability, false\) = false/);
    expect(SQL).toMatch(/create trigger appointments_enforce_buffer_trg\s*\n\s*before insert or update/);
  });
});

describe("0152 — validator + commands are override-gated", () => {
  it("validate_appointment_availability returns buffer_conflict only when NOT allowing outside", () => {
    expect(SQL).toMatch(
      /if not p_allow_outside_availability then[\s\S]*?appointment_buffer_conflict[\s\S]*?return 'buffer_conflict'/,
    );
  });

  it("create_internal_appointment_v2 stamps booked_outside_availability = p_allow_outside_availability", () => {
    expect(SQL).toMatch(/create or replace function public\.create_internal_appointment_v2/);
    expect(SQL).toMatch(/booked_outside_availability\)[\s\S]*?p_allow_outside_availability\)/);
  });

  it("move_or_reassign_appointment (p_appointment_id first) stamps the override flag on the moved row", () => {
    expect(SQL).toMatch(
      /create or replace function public\.move_or_reassign_appointment\(\s*\n\s*p_appointment_id\s+uuid,/,
    );
    expect(SQL).toMatch(/booked_outside_availability = p_allow_outside_availability/);
  });
});

describe("0152 — least privilege (service_role only)", () => {
  it("revokes from public/anon/authenticated and grants only service_role for each callable", () => {
    for (const fn of [
      "appointment_buffer_conflict",
      "validate_appointment_availability",
      "create_internal_appointment_v2",
      "move_or_reassign_appointment",
    ]) {
      expect(SQL).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`),
      );
      expect(SQL).toMatch(
        new RegExp(`grant  execute on function public\\.${fn}\\([^)]*\\) to service_role`),
      );
    }
  });
});
