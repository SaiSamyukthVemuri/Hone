import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #287. Treatment image archive scope + zero-row handling.
//
// archiveTreatmentImageAction previously scoped its conditional UPDATE by
// id + studio_id only and never checked that a row was actually changed. So
// (a) a Client A route call with Client B's same-studio image id archived the
// wrong client's photo, and (b) a nonexistent / already-archived id updated
// zero rows yet returned { ok: true }. The fix scopes by id + studio_id +
// client_id + deleted_at-null and requires exactly one changed row, returning
// a generic "Treatment photo not found." otherwise.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT_A = "22222222-2222-2222-2222-222222222222";
const IMAGE = "33333333-3333-3333-3333-333333333333";
const PRACT = "44444444-4444-4444-4444-444444444444";

// L18 Phase 4: the archive is now the `archive_treatment_image` command
// (migration 0168), so the mock records the RPC name and its arguments instead
// of a chained UPDATE. The scoping it used to assert (id + studio + client +
// not-already-archived) now lives INSIDE the command and is proven in
// tests/db/treatment-image-write-commands.db.test.ts; the studio is derived
// from auth.uid() and is no longer sent at all.
//
// `data` is the command's return: the image id on success, NULL when no row
// matched. That is the same three-state contract the old row-affected check
// produced, so every behavioural case below is unchanged in meaning.
function makeSupabaseMock(result: { data: unknown; error: unknown }) {
  const args: Record<string, unknown> = {};
  let name = "";
  const rpc = vi.fn(async (fn: string, params: Record<string, unknown>) => {
    name = fn;
    Object.assign(args, params);
    return result;
  });
  const from = vi.fn(() => ({ select: vi.fn(async () => ({ data: null, error: null })) }));
  return { client: { rpc, from }, rpc, args, calledName: () => name };
}

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: PRACT, active: true },
    studio: { id: STUDIO },
  })),
}));

import { createClient } from "@/lib/supabase/server";
import { archiveTreatmentImageAction } from "@/app/(app)/clients/[id]/images/actions";

afterEach(() => vi.clearAllMocks());

describe("archiveTreatmentImageAction: scope + zero-row handling", () => {
  it("succeeds when exactly the current client's row is archived", async () => {
    const mock = makeSupabaseMock({ data: IMAGE, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res).toEqual({ ok: true });
    // The command is called with the image and the asserted client. The studio
    // is DERIVED inside it, so it is deliberately not sent.
    expect(mock.calledName()).toBe("archive_treatment_image");
    expect(mock.args.p_image_id).toBe(IMAGE);
    expect(mock.args.p_client_id).toBe(CLIENT_A);
    expect(mock.args).not.toHaveProperty("p_studio_id");
    expect(mock.args).not.toHaveProperty("p_deleted_by");
    // Revalidates only the current client's images page.
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT_A}/images`);
  });

  it("rejects a zero-row update (wrong-client / cross-studio / nonexistent / already-archived) as not found", async () => {
    // The wrong-client / cross-studio / missing / already-deleted cases all
    // produce a zero-row result because the scoped UPDATE matches nothing.
    const mock = makeSupabaseMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res).toEqual({ ok: false, error: "Treatment photo not found." });
    // Still proves the client scope was asserted to the command.
    expect(mock.args.p_client_id).toBe(CLIENT_A);
    // No success side effect: the current page is NOT revalidated.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("treats a null data result as not found (never a silent success)", async () => {
    const mock = makeSupabaseMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res).toEqual({ ok: false, error: "Treatment photo not found." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a generic error on a DB error (never leaks the provider message)", async () => {
    const mock = makeSupabaseMock({ data: null, error: { message: "secret db internals" } });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Could not archive the image.");
      expect(res.error).not.toMatch(/secret db internals/);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the not-found error reveals nothing about another client / studio / image", async () => {
    const mock = makeSupabaseMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    if (!res.ok) {
      expect(res.error).toBe("Treatment photo not found.");
      expect(res.error).not.toMatch(/client|studio|other|exists|B/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the scoping + zero-row check are in place; storage unchanged.
// ---------------------------------------------------------------------------
describe("archive source shape (PR #287)", () => {
  const ACTIONS = readFileSync(
    join(process.cwd(), "app/(app)/clients/[id]/images/actions.ts"),
    "utf8",
  );
  // The archive action body.
  const ARCHIVE =
    ACTIONS.slice(ACTIONS.indexOf("export async function archiveTreatmentImageAction"));

  it("archives through the 0168 command, sending no studio or actor", () => {
    expect(ARCHIVE).toMatch(/rpc\("archive_treatment_image"/);
    expect(ARCHIVE).toMatch(/p_image_id: input\.imageId/);
    expect(ARCHIVE).toMatch(/p_client_id: input\.clientId/);
    expect(ARCHIVE).not.toMatch(/p_studio_id|p_deleted_by/);
    // The scoping moved into the command, assert it there, in the bytes.
    const MIGRATION = readFileSync(
      join(process.cwd(), "supabase/migrations/0168_treatment_image_write_commands.sql"),
      "utf8",
    );
    const seg = MIGRATION.slice(MIGRATION.indexOf("function public.archive_treatment_image("));
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/t\.id = p_image_id/);
    expect(body).toMatch(/t\.studio_id = v_studio/);
    expect(body).toMatch(/t\.client_id = p_client_id/);
    expect(body).toMatch(/t\.deleted_at is null/);
  });

  it("rejects a no-row result as a generic not found", () => {
    expect(ARCHIVE).toMatch(/if \(!data\)/);
    expect(ARCHIVE).toMatch(/error: "Treatment photo not found\."/);
  });

  it("does not change upload/signing/storage behavior (no public URL)", () => {
    expect(ACTIONS).not.toMatch(/getPublicUrl|publicUrl/);
    // The archive action still uses the RLS client, not the service-role one.
    expect(ARCHIVE).not.toMatch(/createAdminClient/);
  });
});
