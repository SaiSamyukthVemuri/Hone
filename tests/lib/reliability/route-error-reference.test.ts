import { describe, expect, it } from "vitest";
import {
  errorDigest,
  MAX_NEXT_ERROR_DIGEST,
  NEXT_ERROR_DIGEST_PATTERN,
  safeErrorReference,
  shouldReportRouteErrorFromClient,
} from "@/lib/reliability/route-error-reference";

// REL-014. What the authenticated error boundary is allowed to show a user as a
// support reference, and when the client boundary is allowed to report.

describe("safeErrorReference — the shapes Next.js actually produces", () => {
  it("accepts a plain server digest", () => {
    // stringHash(message + stack) >>> 0, base 10. This is what a thrown
    // Error in a Server Component yields.
    expect(safeErrorReference("3142859661")).toBe("3142859661");
    expect(safeErrorReference("0")).toBe("0");
  });

  it("accepts a digest carrying Next's internal error code suffix", () => {
    expect(safeErrorReference("3142859661@E394")).toBe("3142859661@E394");
  });

  it("trims incidental whitespace rather than rejecting the digest", () => {
    expect(safeErrorReference("  3142859661  ")).toBe("3142859661");
  });
});

describe("safeErrorReference — everything else yields NO reference", () => {
  it("rejects absence, so the UI renders no line instead of 'undefined'", () => {
    expect(safeErrorReference(undefined)).toBeNull();
    expect(safeErrorReference(null)).toBeNull();
    expect(safeErrorReference("")).toBeNull();
    expect(safeErrorReference("   ")).toBeNull();
  });

  it("rejects non-strings, which JSON transport can deliver", () => {
    // `digest` arrives as JSON.parse of the flight row, so its runtime type is
    // not guaranteed by the TypeScript declaration.
    expect(safeErrorReference(12345)).toBeNull();
    expect(safeErrorReference({ digest: "1" })).toBeNull();
    expect(safeErrorReference(["1"])).toBeNull();
    expect(safeErrorReference(true)).toBeNull();
  });

  it("rejects Next's well-known routing digests, which carry a destination", () => {
    // These are re-thrown by Next's boundary rather than handed to error.tsx,
    // so this is defence in depth: a redirect target is not a support
    // reference, and must never be painted onto the page.
    expect(safeErrorReference("NEXT_REDIRECT;replace;/login;307;")).toBeNull();
    expect(
      safeErrorReference("NEXT_REDIRECT;push;/no-access?reason=multiple-studios;307;"),
    ).toBeNull();
    expect(safeErrorReference("NEXT_HTTP_ERROR_FALLBACK;404")).toBeNull();
    expect(safeErrorReference("DYNAMIC_SERVER_USAGE")).toBeNull();
  });

  it("rejects anything that could carry PII or raw error text", () => {
    // Next respects a pre-existing err.digest instead of regenerating one, and
    // a browser-side error's digest is whatever set it, so free-form text is
    // reachable in principle. Fail closed on all of it.
    expect(safeErrorReference("chloe@example.com")).toBeNull();
    expect(safeErrorReference("Failed to load clients: permission denied")).toBeNull();
    expect(safeErrorReference("https://alhhybgqdmcdyzpybykj.supabase.co/rest/v1/clients")).toBeNull();
    expect(safeErrorReference("d9b4f0e2-1c3a-4f5b-8e7d-2a1b3c4d5e6f")).toBeNull();
    expect(safeErrorReference("sk_live_51H8xyzAbCdEf")).toBeNull();
    expect(safeErrorReference("<script>alert(1)</script>")).toBeNull();
  });

  // Codex review, PR #580: the pattern used to allow up to 20 digits, but Next
  // cannot produce more than a uint32. Anything larger is not a digest, and
  // accepting it meant a numeric identifier or card-shaped number carried in a
  // pre-existing `err.digest` would render into the page as a reference.
  it("rejects a numeric value larger than Next can produce", () => {
    expect(MAX_NEXT_ERROR_DIGEST).toBe(4294967295);
    expect(safeErrorReference("4294967295")).toBe("4294967295");
    expect(safeErrorReference("4294967296")).toBeNull();
    // The concrete disclosure this closes: a 16-digit card-shaped value.
    expect(safeErrorReference("4111111111111111")).toBeNull();
    // And a plausible internal numeric id.
    expect(safeErrorReference("90071992547409910")).toBeNull();
    expect(safeErrorReference("1".repeat(11))).toBeNull();
    expect(safeErrorReference("1".repeat(20))).toBeNull();
  });

  it("rejects a zero-padded value, which Number.toString never produces", () => {
    expect(safeErrorReference("0411111111")).toBeNull();
    expect(safeErrorReference("0000000001")).toBeNull();
    // A bare zero is still a legitimate hash result.
    expect(safeErrorReference("0")).toBe("0");
  });

  it("still accepts every digest Next CAN generate, so support keeps a reference", () => {
    // stringHash ends in `>>> 0`, so the numeric part is a uint32 rendered by
    // Number.prototype.toString: 1 to 10 digits, never padded.
    for (const value of [0, 1, 42, 999999999, 2969792940, MAX_NEXT_ERROR_DIGEST]) {
      const digest = String(value);
      expect(safeErrorReference(digest), digest).toBe(digest);
      expect(safeErrorReference(`${digest}@E394`), digest).toBe(`${digest}@E394`);
    }
  });

  it("the pattern is anchored, so a valid digest cannot smuggle a suffix", () => {
    expect(NEXT_ERROR_DIGEST_PATTERN.test("3142859661 and then some")).toBe(false);
    expect(NEXT_ERROR_DIGEST_PATTERN.test("3142859661\nchloe@example.com")).toBe(false);
    expect(safeErrorReference("3142859661;/login")).toBeNull();
  });
});

// Codex review, PR #580: a boundary must not assume the thrown value is an
// Error. React hands it whatever was actually thrown, and `throw null` is legal.
// An unguarded `error.digest` raised a TypeError inside the boundary's own
// render, which escaped to global-error.tsx, which dereferenced the same way and
// failed too: a blank document, exactly when the boundary is needed most.
describe("errorDigest — reading a digest off a non-Error throw", () => {
  it("returns undefined instead of throwing for a non-object thrown value", () => {
    for (const thrown of [null, undefined, "a thrown string", 42, true, Symbol("s")]) {
      expect(() => errorDigest(thrown), String(thrown)).not.toThrow();
      expect(errorDigest(thrown), String(thrown)).toBeUndefined();
    }
  });

  it("still reads the digest off a real Error", () => {
    expect(errorDigest(Object.assign(new Error("boom"), { digest: "42" }))).toBe("42");
    expect(errorDigest({ digest: "3142859661" })).toBe("3142859661");
    expect(errorDigest(new Error("boom"))).toBeUndefined();
  });

  it("composes with safeErrorReference so a non-Error throw shows no reference", () => {
    for (const thrown of [null, undefined, "text", 0]) {
      expect(safeErrorReference(errorDigest(thrown)), String(thrown)).toBeNull();
    }
  });
});

describe("shouldReportRouteErrorFromClient — no double reporting, no lost reports", () => {
  it("does NOT report a server-originated error", () => {
    // instrumentation.ts already exports onRequestError = captureRequestError,
    // which captures this with the real message and the real stack. The browser
    // copy is the elided placeholder, so a second capture would be a duplicate
    // AND would collapse every distinct server failure into one Sentry issue.
    expect(shouldReportRouteErrorFromClient({ digest: "3142859661" })).toBe(false);
    expect(shouldReportRouteErrorFromClient({ digest: "3142859661@E394" })).toBe(false);
    const withDigest = Object.assign(new Error("boom"), { digest: "42" });
    expect(shouldReportRouteErrorFromClient(withDigest)).toBe(false);
  });

  it("DOES report a browser-raised error", () => {
    // No digest means the server never saw it, so onRequestError never fired.
    // The Sentry browser SDK does not auto-capture these either: React hands a
    // render error to the nearest boundary, not to window.onerror, and no
    // console/react integration is configured in instrumentation-client.ts.
    // Without this branch, adding a boundary would DELETE client-side error
    // reporting for the whole authenticated app.
    expect(shouldReportRouteErrorFromClient(new Error("boom"))).toBe(true);
    expect(shouldReportRouteErrorFromClient({})).toBe(true);
    expect(shouldReportRouteErrorFromClient({ digest: undefined })).toBe(true);
  });

  it("reports when the digest is present but empty or not a string", () => {
    expect(shouldReportRouteErrorFromClient({ digest: "" })).toBe(true);
    expect(shouldReportRouteErrorFromClient({ digest: "   " })).toBe(true);
    expect(shouldReportRouteErrorFromClient({ digest: 42 })).toBe(true);
    expect(shouldReportRouteErrorFromClient({ digest: null })).toBe(true);
  });

  it("reports for a non-object thrown value rather than staying silent", () => {
    expect(shouldReportRouteErrorFromClient(null)).toBe(true);
    expect(shouldReportRouteErrorFromClient(undefined)).toBe(true);
    expect(shouldReportRouteErrorFromClient("a thrown string")).toBe(true);
  });

  it("a reportable digest and a displayable digest are decided independently", () => {
    // A redirect-shaped digest is NOT displayable, but it IS server-originated,
    // so it must not be re-reported from the browser. Conflating the two
    // decisions would reintroduce double reporting for exactly the errors Next
    // generates most often.
    const routing = { digest: "NEXT_REDIRECT;replace;/login;307;" };
    expect(safeErrorReference(routing.digest)).toBeNull();
    expect(shouldReportRouteErrorFromClient(routing)).toBe(false);
  });
});
