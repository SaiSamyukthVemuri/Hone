import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
const touched: string[] = [];
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      touched.push(t);
      throw new Error(`service role read of ${t}`);
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { liveWorkerDeps } = await import("@/lib/waitlist/over-invite-run");

// `service_role` has NO table privilege on the waitlist entries (the commands are the only service path), so any service-role read of that table fails at the
// privilege layer on a real stack and leaves every item unprocessed. The worker therefore reads nothing there: the admit command validates the entry and
// returns the address. (This was found by the browser proof, not by a mocked unit test, which is why it is pinned both ways.)
describe("the background worker never reads the waitlist entries with the service role", () => {
  it("its pre-send check asks the database nothing", async () => {
    const deps = liveWorkerDeps(async () => {});
    const r = await deps.mayStillSend({ itemId: "i", studioId: "s", entryId: "e", batchId: "b", actorUserId: "a" } as never);
    expect(r).toBe("sendable");
    expect(touched).toEqual([]);
  });
  it("no source of the worker reads that table through the admin client", () => {
    for (const f of ["lib/waitlist/over-invite-deliver.ts", "lib/waitlist/over-invite-run.ts", "lib/waitlist/over-invite-worker.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/createAdminClient\(\)[\s\S]{0,80}new_client_waitlist_entries/);
    }
    const deliver = readFileSync("lib/waitlist/over-invite-deliver.ts", "utf8");
    // The only read of the entry's address goes through the caller's reader (the owner's own session), never the admin client.
    expect(deliver).toMatch(/reader\.from\("new_client_waitlist_entries"\)/);
    expect(deliver).not.toMatch(/createAdminClient\(\)\s*\.from\("new_client_waitlist_entries"\)/);
  });
});
