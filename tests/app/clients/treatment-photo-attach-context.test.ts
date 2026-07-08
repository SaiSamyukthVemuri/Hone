import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #284. Attach Treatment Photos to a session / session-block at upload.
//
// The storage/security boundary is unchanged (PR #276/#277): private bucket,
// service-role-gated storage, byte-sanitizer + EXIF strip, path validation,
// orphan cleanup, no public URLs. This PR only POPULATES the already-existing
// nullable session_id / session_block_id columns (migration 0092) with ids
// that are VALIDATED server-side (mirroring the 0093 parent-consistency
// trigger). lib/app is pinned via source-grep (matching the existing image
// test suite); the DB trigger backstop is pinned by
// tests/db/treatment-image-hardening.db.test.ts + 0093 migration test.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const MANAGER = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const CONTEXT = read("app/(app)/clients/[id]/images/photo-context.ts");

// ---------------------------------------------------------------------------
// Upload action: stores validated context ids; default stays client photo.
// ---------------------------------------------------------------------------
describe("upload action populates validated session/block ids", () => {
  it("reads sessionId + sessionBlockId from the form (no longer hardcoded null)", () => {
    expect(ACTIONS).toMatch(/formData\.get\("sessionId"\)/);
    expect(ACTIONS).toMatch(/formData\.get\("sessionBlockId"\)/);
    // The insert uses the resolved variables, not literal null.
    expect(ACTIONS).toMatch(/session_id:\s*sessionId/);
    expect(ACTIONS).toMatch(/session_block_id:\s*sessionBlockId/);
    expect(ACTIONS).not.toMatch(/session_id:\s*null/);
    expect(ACTIONS).not.toMatch(/session_block_id:\s*null/);
  });

  it("default (no context submitted) keeps both ids null → client photo", () => {
    // The locals initialise to null and are only set after validation passes.
    expect(ACTIONS).toMatch(/let sessionId: string \| null = null/);
    expect(ACTIONS).toMatch(/let sessionBlockId: string \| null = null/);
  });
});

// ---------------------------------------------------------------------------
// Server-side validation: cross-tenant / mismatched parents rejected.
// ---------------------------------------------------------------------------
describe("server-side context validation (never trusts client ids)", () => {
  it("validates a session against THIS studio + client", () => {
    // The sessions lookup is scoped by both studio_id and client_id.
    const sessQuery =
      ACTIONS.match(/\.from\("sessions"\)[\s\S]*?\.maybeSingle\(\)/)?.[0] ?? "";
    expect(sessQuery).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(sessQuery).toMatch(/\.eq\("client_id", clientId\)/);
  });

  it("validates a block against THIS studio and derives its session (block∈session+studio)", () => {
    const blockQuery =
      ACTIONS.match(/\.from\("session_blocks"\)[\s\S]*?\.maybeSingle\(\)/)?.[0] ??
      "";
    expect(blockQuery).toMatch(/\.eq\("studio_id", studio\.id\)/);
    // Session is derived from the block row, and the parent session's studio +
    // client are re-checked.
    expect(ACTIONS).toMatch(/sessions!inner\s*\(\s*id,\s*studio_id,\s*client_id\s*\)/);
    expect(ACTIONS).toMatch(/parent\.studio_id !== studio\.id/);
    expect(ACTIONS).toMatch(/parent\.client_id !== clientId/);
    expect(ACTIONS).toMatch(/sessionId = block\.session_id/);
  });

  it("a block cannot be attached without (or mismatched against) its session", () => {
    // If the form also sent a session id, it must equal the block's session.
    expect(ACTIONS).toMatch(
      /requestedSessionId && requestedSessionId !== block\.session_id/,
    );
  });

  it("invalid/cross-tenant ids return a generic error, never a raw id or DB message", () => {
    expect(ACTIONS).toMatch(/is not available for this client/);
    // The generic errors carry no interpolated id.
    const errs = ACTIONS.match(/error: "[^"]*not available[^"]*"/g) ?? [];
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) expect(e).not.toMatch(/\$\{/);
  });
});

// ---------------------------------------------------------------------------
// Storage/security boundary unchanged (regression guard).
// ---------------------------------------------------------------------------
describe("storage + sanitizer + orphan cleanup unchanged", () => {
  it("still sanitizes BEFORE upload (PR #277) and uploads sanitized bytes", () => {
    expect(ACTIONS).toMatch(/sanitizeTreatmentImage/);
    const sanIdx = ACTIONS.indexOf("sanitizeTreatmentImage(");
    const upIdx = ACTIONS.indexOf(".upload(storagePath, sanitized.bytes");
    expect(sanIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeGreaterThan(sanIdx);
  });

  it("still validates the storage path is studio/client-bound (PR #276)", () => {
    expect(ACTIONS).toMatch(/validateTreatmentImagePath/);
    expect(ACTIONS).toMatch(/buildTreatmentImagePath/);
  });

  it("still cleans up the orphaned object on metadata-insert failure", () => {
    expect(ACTIONS).toMatch(/treatment_image_orphan_cleanup_failed/);
    expect(ACTIONS).toMatch(/\.remove\(\[storagePath\]\)/);
  });

  it("no getPublicUrl / public URL is introduced", () => {
    expect(ACTIONS).not.toMatch(/getPublicUrl|publicUrl/);
    expect(PAGE).not.toMatch(/getPublicUrl|publicUrl/);
    expect(MANAGER).not.toMatch(/getPublicUrl|publicUrl/);
  });

  it("the action did not gain a migration / schema change marker", () => {
    // PR #284 is no-migration: it only sets columns that already exist (0092).
    expect(ACTIONS).not.toMatch(/alter table|create table|add column/i);
  });
});

// ---------------------------------------------------------------------------
// Page loads recent sessions safely (studio + client scoped, RLS client).
// ---------------------------------------------------------------------------
describe("page loads recent sessions for the selector (scoped, RLS client)", () => {
  it("queries recent sessions for THIS studio + client, bounded + embeds block areas", () => {
    const q =
      PAGE.match(/\.from\("sessions"\)[\s\S]*?\.limit\(\d+\)/)?.[0] ?? "";
    expect(q).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(q).toMatch(/\.eq\("client_id", id\)/);
    expect(q).toMatch(/session_blocks\s*\(\s*id,\s*primary_area,\s*side,\s*custom_area_detail\s*\)/);
    expect(q).toMatch(/\.order\("started_at",\s*\{\s*ascending:\s*false\s*\}\)/);
  });

  it("uses the RLS client (not the service-role admin) for the session read", () => {
    // The admin client is only used for storage signing, never for the
    // session/clients metadata reads.
    expect(PAGE).toMatch(/const supabase = await createClient\(\)/);
    expect(PAGE).not.toMatch(/admin[\s\S]{0,40}\.from\("sessions"\)/);
  });

  it("only ids + display labels reach the client (the option value is the id)", () => {
    expect(PAGE).toMatch(/sessionBlockOptionLabel/);
    expect(CONTEXT).toMatch(/export function sessionBlockOptionLabel/);
  });
});

// ---------------------------------------------------------------------------
// UI: the Photo context selector.
// ---------------------------------------------------------------------------
describe("Photo context selector UI", () => {
  it("renders the three context choices", () => {
    expect(MANAGER).toMatch(/Client photo/);
    expect(MANAGER).toMatch(/Session photo/);
    expect(MANAGER).toMatch(/Treatment area photo/);
  });

  it("defaults to client photo", () => {
    expect(MANAGER).toMatch(/useState<PhotoContextKind>\("client"\)/);
  });

  it("falls back to client-only messaging when the client has no sessions", () => {
    expect(MANAGER).toMatch(/const hasSessions = sessionOptions\.length > 0/);
    expect(MANAGER).toMatch(/No sessions yet for this client/);
  });

  it("session/block selects submit the ids; block requires a chosen area", () => {
    expect(MANAGER).toMatch(/context\.sessionId = ctxSessionId/);
    expect(MANAGER).toMatch(/context\.sessionBlockId = ctxBlockId/);
    expect(MANAGER).toMatch(/Choose a treatment area/);
  });

  it("shows a 'Will attach as…' summary before upload + shows area labels", () => {
    expect(MANAGER).toMatch(/Will attach as:/);
    expect(MANAGER).toMatch(/b\.areaLabel/);
  });

  it("is mobile-friendly (stacked / full-width controls) and the manager stays service-role-free", () => {
    expect(MANAGER).toMatch(/w-full/);
    expect(MANAGER).not.toMatch(/admin-server|createAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("renders no raw ids/storage paths as visible text (ids live only in option values)", () => {
    // No storage path / bucket text rendered.
    expect(MANAGER).not.toMatch(/storage_path|storage_bucket/);
  });
});

// ---------------------------------------------------------------------------
// Context-tag label helper (concise option label).
// ---------------------------------------------------------------------------
describe("sessionBlockOptionLabel", () => {
  it("is pure + display-only (no id/path leakage) and falls back to 'Area not recorded'", () => {
    expect(CONTEXT).toMatch(/return "Area not recorded"/);
    // No raw-id formatting in the helper.
    expect(CONTEXT).not.toMatch(/storage_path|session_block_id:/);
  });
});
