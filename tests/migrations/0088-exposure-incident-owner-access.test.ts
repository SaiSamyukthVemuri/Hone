import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #222 (migration 0088): exposure incident owner access tier.
// Static pins over the migration SQL; the BEHAVIOR is proven by the
// DB lane (tests/db/exposure-incident-owner-access.db.test.ts).

const SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/0088_exposure_incident_owner_access.sql",
  ),
  "utf8",
);

describe("0088: exposure incident policies", () => {
  it("SELECT is owner-only", () => {
    expect(SQL).toMatch(
      /create policy "record_keeping_exposure_incidents: owner select"\n\s+on public\.record_keeping_exposure_incidents for select to authenticated\n\s+using \(public\.is_studio_owner\(studio_id\)\);/,
    );
  });

  it("UPDATE is owner-only with both USING and WITH CHECK", () => {
    expect(SQL).toMatch(
      /create policy "record_keeping_exposure_incidents: owner update"\n\s+on public\.record_keeping_exposure_incidents for update to authenticated\n\s+using \(public\.is_studio_owner\(studio_id\)\)\n\s+with check \(public\.is_studio_owner\(studio_id\)\);/,
    );
  });

  it("INSERT stays member-wide", () => {
    expect(SQL).toMatch(
      /create policy "record_keeping_exposure_incidents: members insert"\n\s+on public\.record_keeping_exposure_incidents for insert to authenticated\n\s+with check \(public\.is_studio_member\(studio_id\)\);/,
    );
  });

  it("no DELETE policy and no FOR ALL policy is created", () => {
    expect(SQL).not.toMatch(/for delete/i);
    expect(SQL).not.toMatch(/for all/i);
  });

  it("the old member-wide select/update policies are dropped", () => {
    expect(SQL).toMatch(
      /drop policy if exists "record_keeping_exposure_incidents: members select"/,
    );
    expect(SQL).toMatch(
      /drop policy if exists "record_keeping_exposure_incidents: members update"/,
    );
  });

  it("no anon policies and no grants", () => {
    expect(SQL).not.toMatch(/to anon/);
    expect(SQL).not.toMatch(/^\s*grant\s/im);
  });

  it("policy-only: no schema or data statements", () => {
    expect(SQL).not.toMatch(/create table|alter table|add column|drop column/i);
    expect(SQL).not.toMatch(/^\s*(insert into|update public\.|delete from)/im);
  });
});

describe("0088: audit events carve-out", () => {
  it("audit SELECT keeps member access but owner-gates exposure rows", () => {
    expect(SQL).toMatch(
      /create policy "record_keeping_audit_events: members select"[\s\S]*?public\.is_studio_member\(studio_id\)[\s\S]*?record_type <> 'exposure_incident'[\s\S]*?or public\.is_studio_owner\(studio_id\)/,
    );
  });

  it("touches ONLY the SELECT policy on the audit table (immutability untouched)", () => {
    const auditStatements = SQL.match(
      /(create|drop) policy (if exists )?"record_keeping_audit_events[^"]*"/g,
    );
    expect(auditStatements).toEqual([
      'drop policy if exists "record_keeping_audit_events: members select"',
      'create policy "record_keeping_audit_events: members select"',
    ]);
  });

  it("a validator asserts the final posture before commit", () => {
    expect(SQL).toMatch(/raise exception/);
    expect(SQL).toMatch(/begin;[\s\S]*commit;\s*$/);
  });
});
