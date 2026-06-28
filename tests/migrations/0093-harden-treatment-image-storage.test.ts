import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #276. SQL-text pin for migration 0093 (treatment image storage hardening).
// Behavioral proof is in tests/db/treatment-image-hardening.db.test.ts (db lane);
// this pins the migration shape so the hardening cannot silently regress.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0093_harden_treatment_image_storage.sql"),
  "utf8",
);

describe("0093 keeps the bucket private", () => {
  it("forces public=false on treatment-images", () => {
    expect(SQL).toMatch(/update storage\.buckets set public = false/);
    expect(SQL).toMatch(/id = 'treatment-images'/);
  });
});

describe("0093 removes direct authenticated storage.objects access", () => {
  it("drops the authenticated treatment-images object policies", () => {
    expect(SQL).toMatch(/drop policy if exists "treatment_images_objects: members select" on storage\.objects/);
    expect(SQL).toMatch(/drop policy if exists "treatment_images_objects: members insert" on storage\.objects/);
  });
  it("does NOT (re)create any authenticated/anon storage.objects policy for the bucket", () => {
    expect(SQL).not.toMatch(/create policy "treatment_images_objects/);
    expect(SQL).not.toMatch(/to anon/);
    expect(SQL).not.toMatch(/getPublicUrl|public = true/);
  });
});

describe("0093 binds metadata path/bucket to the row", () => {
  it("fixes the bucket via CHECK", () => {
    expect(SQL).toMatch(/treatment_images_bucket_fixed_chk/);
    expect(SQL).toMatch(/check \(storage_bucket = 'treatment-images'\)/);
  });
  it("binds the path to studio_id/client_id + allowed extension via CHECK", () => {
    expect(SQL).toMatch(/treatment_images_path_shape_chk/);
    expect(SQL).toMatch(/studio_id::text \|\| '\/' \|\| client_id::text/);
    expect(SQL).toMatch(/\[A-Za-z0-9\._-\]\+\\\.\(jpg\|jpeg\|png\|webp\)/);
  });
  it("requires a session when a session block is attached", () => {
    expect(SQL).toMatch(/treatment_images_block_requires_session_chk/);
    expect(SQL).toMatch(/session_block_id is null or session_id is not null/);
  });
});

describe("0093 enforces parent consistency + identity immutability", () => {
  it("defines the integrity trigger function + BEFORE INSERT OR UPDATE trigger", () => {
    expect(SQL).toMatch(/function public\.enforce_treatment_image_integrity\(\)/);
    expect(SQL).toMatch(/before insert or update on public\.treatment_images/);
    expect(SQL).toMatch(/treatment_images_enforce_integrity/);
  });
  it("checks client/session/block belong to the same studio (+ client/session)", () => {
    expect(SQL).toMatch(/from public\.clients c[\s\S]*c\.studio_id = NEW\.studio_id/);
    expect(SQL).toMatch(/from public\.sessions s[\s\S]*s\.client_id = NEW\.client_id/);
    expect(SQL).toMatch(/from public\.session_blocks b[\s\S]*b\.session_id = NEW\.session_id/);
  });
  it("freezes identity columns on UPDATE", () => {
    expect(SQL).toMatch(/identity columns are immutable/);
    expect(SQL).toMatch(/NEW\.storage_path\s+is distinct from OLD\.storage_path/);
  });
});
