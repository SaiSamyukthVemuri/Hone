import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let answer: { data: unknown; error: unknown } = { data: null, error: null };
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq"]) q[k] = () => q;
    q.maybeSingle = async () => answer;
    return q;
  },
}));

import { mayStillSend } from "@/lib/waitlist/over-invite-deliver";

// The real read behind the worker's pre-send check: a FAILED read is never reported as "not sendable" (that would permanently skip a person).
describe("mayStillSend", () => {
  it("a query error is read_failed, not a definitive answer", async () => {
    answer = { data: null, error: { message: "boom" } };
    expect(await mayStillSend("s", "e")).toBe("read_failed");
  });
  it("no such entry in the studio is a definitive not_sendable", async () => {
    answer = { data: null, error: null };
    expect(await mayStillSend("s", "e")).toBe("not_sendable");
  });
  it("an entry that is no longer waiting, or has no address, is not_sendable", async () => {
    answer = { data: { email: "a@b.c", status: "removed" }, error: null };
    expect(await mayStillSend("s", "e")).toBe("not_sendable");
    answer = { data: { email: "", status: "waiting" }, error: null };
    expect(await mayStillSend("s", "e")).toBe("not_sendable");
  });
  it("a waiting or invited entry with an address is sendable", async () => {
    for (const status of ["waiting", "invited"]) {
      answer = { data: { email: "a@b.c", status }, error: null };
      expect(await mayStillSend("s", "e")).toBe("sendable");
    }
  });
});
