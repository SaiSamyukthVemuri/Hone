import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readStudioLive } from "@/lib/billing/studio-live";

// C (Sam, 28 Nov 2026): a studio is LIVE with a live-mode Connect row that has an account id (any status), OR a succeeded live card attempt; a failed read is null (fail closed).
function fake(t: { settings?: unknown[]; attempts?: unknown[]; fail?: "settings" | "attempts" }) {
  return { from(table: string) {
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, { select: self, eq: self, not: self, limit: self,
      then: (res: (v: unknown) => unknown) => res(t.fail === (table === "studio_payment_settings" ? "settings" : "attempts") ? { data: null, error: { message: "x" } } : { data: table === "studio_payment_settings" ? t.settings ?? [] : t.attempts ?? [], error: null }) });
    return q;
  } } as never;
}
describe("readStudioLive", () => {
  it("a trial studio (no live row, no live attempt) is not live", async () => { expect(await readStudioLive(fake({}), "s")).toBe(false); });
  it("a live Connect row alone makes the studio live (no payment needed)", async () => { expect(await readStudioLive(fake({ settings: [{ studio_id: "s" }] }), "s")).toBe(true); });
  it("a succeeded live attempt alone makes the studio live", async () => { expect(await readStudioLive(fake({ attempts: [{ id: "a" }] }), "s")).toBe(true); });
  it("a failed read of either source is null, never a guess", async () => {
    expect(await readStudioLive(fake({ fail: "settings" }), "s")).toBeNull();
    expect(await readStudioLive(fake({ fail: "attempts", settings: [{ studio_id: "s" }] }), "s")).toBeNull();
  });
});
