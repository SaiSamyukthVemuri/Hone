import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSignedImageUrl, signedImageUrlPath } from "@/lib/images/remint-request";

// FETT photos (HON-43): the browser side of a re-mint. A URL only from a 200;
// every other answer — 4xx, 5xx, and the session middleware's 307 to /login or
// /no-access (an opaque redirect under redirect: "manual") — is a DEFINITIVE
// null; a network failure or an abort REJECTS (the hook's retry path).

const C = "22222222-2222-2222-2222-222222222222";
const I = "33333333-3333-3333-3333-333333333333";

function stub(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  const f = vi.fn(async () => ({ type: "basic", status: 200, json: async () => ({}), ...res }) as Response);
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSignedImageUrl", () => {
  it("GETs the route, never cached, same-origin, redirects NOT followed, with the attempt's signal", async () => {
    const f = stub({ json: async () => ({ url: "https://s/x" }) });
    const ac = new AbortController();
    expect(await fetchSignedImageUrl({ clientId: C, imageId: I, variant: "thumb", signal: ac.signal })).toBe("https://s/x");
    expect(f).toHaveBeenCalledWith(`/api/clients/${C}/images/${I}/signed-url?variant=thumb`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal: ac.signal,
    });
  });

  it("the path encodes its segments", () => {
    expect(signedImageUrlPath("a/b", "c?d", "original")).toBe("/api/clients/a%2Fb/images/c%3Fd/signed-url?variant=original");
  });

  it.each([
    ["an opaque redirect (middleware → /login or /no-access)", { type: "opaqueredirect", status: 0 }],
    ["a 307", { status: 307 }],
    ["401", { status: 401 }],
    ["403", { status: 403 }],
    ["404", { status: 404 }],
    ["500", { status: 500 }],
  ] as const)("%s → null (definitive)", async (_l, res) => {
    stub(res as Partial<Response>);
    expect(await fetchSignedImageUrl({ clientId: C, imageId: I, variant: "thumb", signal: new AbortController().signal })).toBeNull();
  });

  it("a 200 without a usable url → null", async () => {
    stub({ json: async () => ({ url: "" }) });
    expect(await fetchSignedImageUrl({ clientId: C, imageId: I, variant: "thumb", signal: new AbortController().signal })).toBeNull();
    stub({ json: async () => Promise.reject(new SyntaxError("not json")) });
    expect(await fetchSignedImageUrl({ clientId: C, imageId: I, variant: "thumb", signal: new AbortController().signal })).toBeNull();
  });

  it("a network failure or abort REJECTS (retry path, not terminal)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("aborted", "AbortError"))));
    await expect(
      fetchSignedImageUrl({ clientId: C, imageId: I, variant: "thumb", signal: new AbortController().signal }),
    ).rejects.toThrow();
  });
});
