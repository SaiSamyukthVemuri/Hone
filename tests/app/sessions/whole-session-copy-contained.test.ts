import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioural proof that the TEMPORARILY CONTAINED whole-session copy action
// writes nothing, even when called DIRECTLY (bypassing the UI, which no longer
// renders an interactive control). The real action is invoked; the DB client
// constructor is a spy that must NEVER be called, so we prove zero reads and
// zero writes (no session_blocks, electrolysis_entries, session_block_areas,
// drafts, metrics, or audit records) after the auth + current-session lineage
// checks pass.

// Spies are created via vi.hoisted so they exist when the hoisted vi.mock
// factories run. There are TWO DB paths out of this module: the RLS client
// (@/lib/supabase/server createClient) and the service-role client
// (@/lib/supabase/admin-server createAdminClient, the audit/metrics path).
// Spies that throw prove, behaviourally, that the contained action touches
// NEITHER, so it writes no blocks/entries/areas AND no metrics/audit rows.
const {
  createClientSpy,
  createAdminClientSpy,
  assertSessionForClient,
  getCurrentPractitionerWithStudio,
} = vi.hoisted(() => ({
  createClientSpy: vi.fn(() => {
    throw new Error("createClient must not be called by the contained whole-session copy");
  }),
  createAdminClientSpy: vi.fn(() => {
    throw new Error("createAdminClient must not be called by the contained whole-session copy");
  }),
  assertSessionForClient: vi.fn(async () => undefined),
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "prac-1", active: true },
    studio: { id: "studio-1" },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: createAdminClientSpy }));
vi.mock("@/lib/sessions/session-lineage", () => ({ assertSessionForClient }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio }));

import { copyPreviousSessionAreasAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions";

const input = { clientId: "client-1", sessionId: "session-today", previousSessionId: "session-prev" };

describe("whole-session copy: contained, zero writes, cannot be bypassed", () => {
  beforeEach(() => {
    createClientSpy.mockClear();
    createAdminClientSpy.mockClear();
    assertSessionForClient.mockClear();
    getCurrentPractitionerWithStudio.mockClear();
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: "prac-1", active: true },
      studio: { id: "studio-1" },
    });
  });

  it("returns a fixed 'temporarily unavailable' result", async () => {
    const res = await copyPreviousSessionAreasAction(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/temporarily unavailable/i);
  });

  it("NEVER constructs a DB client, zero session_blocks / electrolysis_entries / session_block_areas / drafts / metrics / audit", async () => {
    const res = await copyPreviousSessionAreasAction(input);
    expect(res.ok).toBe(false);
    // Neither DB client was ever created => no read of the source session and no
    // insert of any block, entry, area, draft, metric, or audit row (the
    // service-role admin client is the audit/metrics path).
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(createAdminClientSpy).not.toHaveBeenCalled();
  });

  it("cannot be bypassed by calling the server action directly", async () => {
    // This test IS a direct call (no UI, no gating). It still writes nothing on
    // either DB path.
    for (let i = 0; i < 3; i++) await copyPreviousSessionAreasAction(input);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(createAdminClientSpy).not.toHaveBeenCalled();
  });

  it("preserves the current-session lineage check before returning", async () => {
    await copyPreviousSessionAreasAction(input);
    expect(assertSessionForClient).toHaveBeenCalledWith(
      "studio-1",
      "client-1",
      "session-today",
    );
  });

  it("still refuses an inactive practitioner (authentication preserved) and writes nothing", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValueOnce({
      practitioner: { id: "prac-1", active: false },
      studio: { id: "studio-1" },
    });
    const res = await copyPreviousSessionAreasAction(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Inactive practitioners/i);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(createAdminClientSpy).not.toHaveBeenCalled();
  });
});
