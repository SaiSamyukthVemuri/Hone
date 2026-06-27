import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #271 (migration 0092): static SQL-text pin of the secure treatment image
// storage migration — PRIVATE bucket, metadata table, studio-scoped RLS,
// no-delete + privilege hardening, storage.objects defense-in-depth policies.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0092_treatment_images.sql"),
  "utf8",
);

describe("0092 private bucket", () => {
  it("creates the treatment-images bucket as private (public=false)", () => {
    expect(SQL).toMatch(/insert into storage\.buckets/);
    expect(SQL).toMatch(/'treatment-images',\s*'treatment-images',\s*false/);
  });
  it("never creates a public bucket or a public URL", () => {
    expect(SQL).not.toMatch(/'treatment-images',\s*'treatment-images',\s*true/);
    expect(SQL).not.toMatch(/getPublicUrl/);
    expect(SQL).not.toMatch(/public\s*=\s*true/);
  });
});

describe("0092 treatment_images table", () => {
  it("creates the metadata table with required studio_id + client_id", () => {
    expect(SQL).toMatch(/create table if not exists public\.treatment_images/);
    expect(SQL).toMatch(/studio_id uuid not null[\s\S]*references public\.studios\(id\) on delete cascade/);
    expect(SQL).toMatch(/client_id uuid not null[\s\S]*references public\.clients\(id\) on delete cascade/);
  });
  it("links optional session / session_block and stamps storage + uploader", () => {
    expect(SQL).toMatch(/session_id uuid references public\.sessions\(id\) on delete set null/);
    expect(SQL).toMatch(/session_block_id uuid[\s\S]*references public\.session_blocks\(id\) on delete set null/);
    expect(SQL).toMatch(/storage_bucket text not null/);
    expect(SQL).toMatch(/storage_path text not null/);
    expect(SQL).toMatch(/content_type text not null/);
    expect(SQL).toMatch(/size_bytes bigint not null/);
    expect(SQL).toMatch(/uploaded_by uuid references public\.practitioners\(id\)/);
  });
  it("supports soft-delete (deleted_at) only", () => {
    expect(SQL).toMatch(/deleted_at timestamptz/);
    expect(SQL).toMatch(/deleted_by uuid/);
  });
});

describe("0092 RLS + privilege hardening", () => {
  it("enables RLS and grants member select/insert/update", () => {
    expect(SQL).toMatch(/alter table public\.treatment_images enable row level security/);
    expect(SQL).toMatch(/"treatment_images: members select"[\s\S]*using \(public\.is_studio_member\(studio_id\)\)/);
    expect(SQL).toMatch(/"treatment_images: members insert"[\s\S]*with check \(public\.is_studio_member\(studio_id\)\)/);
    expect(SQL).toMatch(/"treatment_images: members update"/);
  });
  it("grants NO delete policy and revokes truncate/delete", () => {
    expect(SQL).not.toMatch(/treatment_images[\s\S]*for delete/i);
    expect(SQL).toMatch(/revoke truncate, delete on public\.treatment_images from anon, authenticated/);
  });
});

describe("0092 storage.objects defense-in-depth", () => {
  it("scopes storage.objects policies to the studio via the first path segment", () => {
    expect(SQL).toMatch(/storage\.objects/);
    expect(SQL).toMatch(/storage\.foldername\(name\)/);
    expect(SQL).toMatch(/is_studio_member\(\(\(storage\.foldername\(name\)\)\[1\]\)::uuid\)/);
    // storage policies are authenticated-only (no anon-granted policy)
    expect(SQL).toMatch(/on storage\.objects for select to authenticated/);
    expect(SQL).not.toMatch(/on storage\.objects for (select|insert|update|delete) to anon/);
  });
});
