import { describe, expect, it } from "vitest";
import { isRedirectError, runClientSave } from "@/lib/clients/client-form-submit";

// P0a: a server action that ends in redirect() REJECTS the awaited promise in the browser. That rejection is the
// server's confirmation, not a failure, and must never be shown as "could not save".

const redirectError = () => Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/clients/c1;307;" });

describe("runClientSave", () => {
  it("a redirect rejection is the server's confirmation: classified as redirect and handed back untouched", async () => {
    const err = redirectError();
    const outcome = await runClientSave(async () => { throw err; }, new FormData());
    expect(outcome).toEqual({ kind: "redirect", redirect: err });
    if (outcome.kind === "redirect") expect(outcome.redirect).toBe(err);
  });
  it("recognises a redirect by digest or by message, and nothing else", () => {
    expect(isRedirectError(redirectError())).toBe(true);
    expect(isRedirectError(new Error("NEXT_REDIRECT:/x"))).toBe(true);
    for (const other of [new Error("boom"), { digest: "NEXT_NOT_FOUND" }, null, undefined, "NEXT_REDIRECT", 7]) {
      expect(isRedirectError(other)).toBe(false);
    }
  });
  it("a genuine server refusal is surfaced as refused, with its message", async () => {
    const outcome = await runClientSave(async () => ({ ok: false as const, error: "Name is required." }), new FormData());
    expect(outcome).toEqual({ kind: "refused", result: { ok: false, error: "Name is required." } });
  });
  it("a real failure (network, unexpected throw) is failed, never saved and never a redirect", async () => {
    expect(await runClientSave(async () => { throw new TypeError("fetch failed"); }, new FormData())).toEqual({ kind: "failed" });
  });
  it("a resolved action with no error is saved", async () => {
    expect(await runClientSave(async () => undefined, new FormData())).toEqual({ kind: "saved" });
  });
});
