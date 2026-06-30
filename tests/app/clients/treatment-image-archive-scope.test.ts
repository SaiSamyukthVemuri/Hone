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

// Chainable Supabase UPDATE mock: records the .eq()/.is() filters and resolves
// .select() with a caller-supplied { data, error }.
function makeSupabaseMock(result: { data: unknown; error: unknown }) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  builder.update = vi.fn(() => builder);
  builder.eq = vi.fn((k: string, v: unknown) => {
    filters[k] = v;
    return builder;
  });
  builder.is = vi.fn((k: string, v: unknown) => {
    filters[`is:${k}`] = v;
    return builder;
  });
  builder.select = vi.fn(async () => result);
  const from = vi.fn(() => builder);
  return { client: { from }, from, filters };
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
    const mock = makeSupabaseMock({ data: [{ id: IMAGE }], error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res).toEqual({ ok: true });
    // The UPDATE is scoped by id + studio_id + client_id + not-already-deleted.
    expect(mock.from).toHaveBeenCalledWith("treatment_images");
    expect(mock.filters.id).toBe(IMAGE);
    expect(mock.filters.studio_id).toBe(STUDIO);
    expect(mock.filters.client_id).toBe(CLIENT_A);
    expect(mock.filters["is:deleted_at"]).toBeNull();
    // Revalidates only the current client's images page.
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT_A}/images`);
  });

  it("rejects a zero-row update (wrong-client / cross-studio / nonexistent / already-archived) as not found", async () => {
    // The wrong-client / cross-studio / missing / already-deleted cases all
    // produce a zero-row result because the scoped UPDATE matches nothing.
    const mock = makeSupabaseMock({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue(mock.client as never);
    const res = await archiveTreatmentImageAction({ imageId: IMAGE, clientId: CLIENT_A });
    expect(res).toEqual({ ok: false, error: "Treatment photo not found." });
    // Still proves the client_id scope was applied.
    expect(mock.filters.client_id).toBe(CLIENT_A);
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
    const mock = makeSupabaseMock({ data: [], error: null });
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

  it("scopes the archive update by id + studio_id + client_id + deleted_at null", () => {
    expect(ARCHIVE).toMatch(/\.eq\("id", input\.imageId\)/);
    expect(ARCHIVE).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(ARCHIVE).toMatch(/\.eq\("client_id", input\.clientId\)/);
    expect(ARCHIVE).toMatch(/\.is\("deleted_at", null\)/);
  });

  it("proves a row was changed via .select(\"id\") and rejects zero rows", () => {
    expect(ARCHIVE).toMatch(/\.select\("id"\)/);
    expect(ARCHIVE).toMatch(/data\.length !== 1/);
    expect(ARCHIVE).toMatch(/error: "Treatment photo not found\."/);
  });

  it("does not change upload/signing/storage behavior (no public URL)", () => {
    expect(ACTIONS).not.toMatch(/getPublicUrl|publicUrl/);
    // The archive action still uses the RLS client, not the service-role one.
    expect(ARCHIVE).not.toMatch(/createAdminClient/);
  });
});
