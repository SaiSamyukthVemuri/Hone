// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { acquireEntry, latestDraft, seedEntry, type DraftActions } from "@/lib/note-drafts/draft-registry";
import type { NoteDraftKey } from "@/lib/note-drafts/types";

// HON-130 (Codex P1 on #1879): module state on the server is shared by every request of an instance. The registry must never be read or written while
// rendering on the server, and never for a studio where autosave is off.
const key: NoteDraftKey = { clientId: "c1", kind: "consultation", target: "new" };
const actions = (scope: string): DraftActions => ({ scope, save: vi.fn(async () => ({ status: "error" as const })), discard: async () => ({ ok: true }), peek: async () => ({ ok: true, draft: null }) });

describe("draft registry without a browser", () => {
  it("is running with no window", () => {
    expect(typeof window).toBe("undefined");
  });

  it("never shares an entry across two practitioners rendering the same key on the server", () => {
    const a = acquireEntry(key, null, actions("practitioner-a:studio-1"), () => undefined);
    a.saver.change({ body: "practitioner A's text" });
    const b = acquireEntry(key, null, actions("practitioner-b:studio-1"), () => undefined);
    expect(b.saver).not.toBe(a.saver);
    expect(b.saver.latestFields()).toBeNull();
    const again = acquireEntry(key, null, actions("practitioner-a:studio-1"), () => undefined);
    expect(again.saver).not.toBe(a.saver); // not even the same practitioner is handed a stored entry on the server
  });

  it("latestDraft returns only what the server page gave, never registry state", () => {
    const a = acquireEntry(key, null, actions("practitioner-a:studio-1"), () => undefined);
    a.saver.change({ body: "held text" });
    expect(latestDraft(key, null, "practitioner-a:studio-1")).toBeNull();
    const stored = { key, fields: { body: "from the server" }, revision: 3, savedAt: "t", generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect(latestDraft(key, stored, "practitioner-b:studio-1")).toEqual({ fields: { body: "from the server" }, revision: 3, savedAt: "t", unsaved: false });
  });

  it("seedEntry does nothing on the server", () => {
    seedEntry(key, { body: "x" }, actions("practitioner-a:studio-1"));
    expect(latestDraft(key, null, "practitioner-a:studio-1")).toBeNull();
  });
});
