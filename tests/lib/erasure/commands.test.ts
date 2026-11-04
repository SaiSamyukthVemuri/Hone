import { describe, expect, it, vi } from "vitest";
import { advanceErasure, clearErasureReason, correctErasureReason, erasureErrorCopy, requestErasure, withdrawErasure, type ErasureCtx } from "@/lib/erasure/commands";

const CLIENT = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const STUDIO = "44444444-4444-4444-8444-444444444444";

function ctx(over: Partial<ErasureCtx["practitioner"]> = {}, rpcResult: { data?: unknown; error: { code?: string } | null } = { error: null }) {
  const rpc = vi.fn(async () => ({ data: rpcResult.data ?? null, error: rpcResult.error }));
  const c: ErasureCtx = { practitioner: { role: "owner", active: true, ...over }, studio: { id: STUDIO }, supabase: { rpc } };
  return { c, rpc };
}

describe("erasure commands: owner first, studio from the session, plain errors (R5, prepared)", () => {
  it("a non-owner, an inactive owner and a receptionist-shaped role are refused BEFORE any database call", async () => {
    for (const over of [{ role: "practitioner" }, { role: "receptionist" }, { active: false }, { role: "" }]) {
      const { c, rpc } = ctx(over);
      for (const r of [await requestErasure(c, { clientId: CLIENT, reason: "x" }), await advanceErasure(c, { requestId: REQ, to: "under_review" }), await withdrawErasure(c, { requestId: REQ })]) {
        expect(r, JSON.stringify(over)).toEqual({ ok: false, error: "Only the studio owner can manage erasure requests." });
      }
      expect(rpc, JSON.stringify(over)).not.toHaveBeenCalled();
    }
  });

  it("request: the studio comes from the session, the reason is trimmed, the call names the held command", async () => {
    const { c, rpc } = ctx();
    expect(await requestErasure(c, { clientId: CLIENT, reason: "  Asked in writing " })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("request_client_erasure", { p_studio: STUDIO, p_client: CLIENT, p_reason: "Asked in writing" });
  });

  it("request: a bad client id or reason never reaches the database", async () => {
    const { c, rpc } = ctx();
    expect((await requestErasure(c, { clientId: "nope", reason: "x" })).ok).toBe(false);
    expect((await requestErasure(c, { clientId: CLIENT, reason: "   " })).ok).toBe(false);
    expect((await requestErasure(c, { clientId: CLIENT, reason: "x".repeat(301) })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("advance: only the two forward targets are accepted; 'executed' and anything else never reaches the database", async () => {
    const { c, rpc } = ctx();
    for (const to of ["executed", "withdrawn", "requested", "", null, undefined]) expect((await advanceErasure(c, { requestId: REQ, to })).ok, String(to)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await advanceErasure(c, { requestId: REQ, to: "confirmed" })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("advance_client_erasure_request", { p_studio: STUDIO, p_request: REQ, p_to: "confirmed" });
  });

  it("correct: a non-owner is refused first; a blank reason clears (p_reason null); text is trimmed; over-long never reaches the database", async () => {
    const denied = ctx({ role: "practitioner" });
    expect((await correctErasureReason(denied.c, { requestId: REQ, reason: "x" })).ok).toBe(false);
    expect(denied.rpc).not.toHaveBeenCalled();
    const { c, rpc } = ctx();
    expect((await correctErasureReason(c, { requestId: "nope", reason: "x" })).ok).toBe(false);
    expect((await correctErasureReason(c, { requestId: REQ, reason: "x".repeat(301) })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    for (const blank of ["   ", "", null, undefined]) expect((await correctErasureReason(c, { requestId: REQ, reason: blank })).ok, String(blank)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await correctErasureReason(c, { requestId: REQ, reason: "  Fixed  " })).toEqual({ ok: true });
    expect(rpc).toHaveBeenLastCalledWith("correct_client_erasure_reason", { p_studio: STUDIO, p_request: REQ, p_reason: "Fixed" });
  });

  it("clear: owner only, sends NULL, and is the only way to clear", async () => {
    const denied = ctx({ role: "practitioner" });
    expect((await clearErasureReason(denied.c, { requestId: REQ })).ok).toBe(false);
    expect(denied.rpc).not.toHaveBeenCalled();
    const { c, rpc } = ctx();
    expect((await clearErasureReason(c, { requestId: "nope" })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await clearErasureReason(c, { requestId: REQ })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("correct_client_erasure_reason", { p_studio: STUDIO, p_request: REQ, p_reason: null });
  });

  it("withdraw calls the held command with the session's studio", async () => {
    const { c, rpc } = ctx();
    expect(await withdrawErasure(c, { requestId: REQ })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("withdraw_client_erasure_request", { p_studio: STUDIO, p_request: REQ });
  });

  it("database codes become plain copy; no id, reason or database text is echoed", async () => {
    const cases: Array<[string | undefined, RegExp]> = [
      ["42501", /Only the studio owner/], ["23505", /already has an open erasure request/], ["23514", /Say why/], ["55000", /not available for this request/],
      ["42883", /not available yet/], ["PGRST202", /not available yet/], ["XX000", /Could not save/], [undefined, /Could not save/],
    ];
    for (const [code, re] of cases) {
      const { c } = ctx({}, { error: { code } });
      const r = await requestErasure(c, { clientId: CLIENT, reason: "SECRET-REASON-TEXT" });
      expect(r.ok).toBe(false);
      const text = JSON.stringify(r);
      expect(text, String(code)).toMatch(re);
      for (const leak of [CLIENT, STUDIO, "SECRET-REASON-TEXT"]) expect(text, `${code} leaks`).not.toContain(leak);
    }
    expect(erasureErrorCopy("42501")).toBe(erasureErrorCopy("42501"));
  });
});
