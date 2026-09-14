import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// ALL PINNED NOTES REACH THE DASHBOARD ROSTER
// ===========================================================================
//
// Chloe: "Not all the pinned notes show up on dashboard. If I pin multiple
// notes I need to see all of them."
//
// The loader used to run this exact query and then keep only the first row per
// client, so pinning was silently a one-slot field. These cases pin the
// replacement: every note, newest first, from ONE studio-scoped query.
// ===========================================================================

const order = vi.fn();
const inFn = vi.fn(() => ({ order }));
const eq = vi.fn(() => ({ in: inFn }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from })),
}));

const { getPinnedNotesByClient } = await import("@/lib/client-pinned-notes/queries");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const note = (id: string, client: string, text: string, created: string) => ({
  id, client_id: client, studio_id: STUDIO, text, created_at: created,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPinnedNotesByClient", () => {
  it("returns ALL THREE notes for one client, newest first", async () => {
    // The query orders created_at desc, so the rows arrive newest-first.
    order.mockResolvedValueOnce({
      data: [
        note("n3", CLIENT_A, "third pinned note", "2026-03-03T00:00:00Z"),
        note("n2", CLIENT_A, "second pinned note", "2026-02-02T00:00:00Z"),
        note("n1", CLIENT_A, "first pinned note", "2026-01-01T00:00:00Z"),
      ],
      error: null,
    });

    const out = await getPinnedNotesByClient(STUDIO, [CLIENT_A]);
    const notes = out.get(CLIENT_A) ?? [];

    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.id)).toEqual(["n3", "n2", "n1"]);
    // Every text survives — not just the newest, and none sliced.
    expect(notes.map((n) => n.text)).toEqual([
      "third pinned note",
      "second pinned note",
      "first pinned note",
    ]);
  });

  it("uses ONE query for every client — no N+1", async () => {
    order.mockResolvedValueOnce({
      data: [
        note("a2", CLIENT_A, "A newer", "2026-02-02T00:00:00Z"),
        note("a1", CLIENT_A, "A older", "2026-01-01T00:00:00Z"),
        note("b1", CLIENT_B, "B only", "2026-01-05T00:00:00Z"),
      ],
      error: null,
    });

    const out = await getPinnedNotesByClient(STUDIO, [CLIENT_A, CLIENT_B]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(order).toHaveBeenCalledTimes(1);
    expect(out.get(CLIENT_A)).toHaveLength(2);
    expect(out.get(CLIENT_B)).toHaveLength(1);
  });

  it("stays scoped to the studio and the requested clients", async () => {
    order.mockResolvedValueOnce({ data: [], error: null });
    await getPinnedNotesByClient(STUDIO, [CLIENT_A, CLIENT_B]);
    expect(eq).toHaveBeenCalledWith("studio_id", STUDIO);
    expect(inFn).toHaveBeenCalledWith("client_id", [CLIENT_A, CLIENT_B]);
  });

  it("applies NO limit or per-client cap", async () => {
    // A cap would recreate the reported defect somewhere less visible.
    const many = Array.from({ length: 25 }, (_, i) =>
      note(`n${i}`, CLIENT_A, `note ${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    order.mockResolvedValueOnce({ data: many, error: null });
    const out = await getPinnedNotesByClient(STUDIO, [CLIENT_A]);
    expect(out.get(CLIENT_A)).toHaveLength(25);
  });

  it("omits clients with no notes, and short-circuits an empty roster", async () => {
    order.mockResolvedValueOnce({
      data: [note("b1", CLIENT_B, "only B", "2026-01-05T00:00:00Z")],
      error: null,
    });
    const out = await getPinnedNotesByClient(STUDIO, [CLIENT_A, CLIENT_B]);
    expect(out.has(CLIENT_A)).toBe(false);
    expect(out.get(CLIENT_B)).toHaveLength(1);

    vi.clearAllMocks();
    const empty = await getPinnedNotesByClient(STUDIO, []);
    expect(empty.size).toBe(0);
    expect(from).not.toHaveBeenCalled();   // no query at all
  });

  it("surfaces a read failure rather than returning a silently empty roster", async () => {
    order.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(getPinnedNotesByClient(STUDIO, [CLIENT_A])).rejects.toThrow(/boom/);
  });
});
