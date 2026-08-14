import { describe, expect, it } from "vitest";
import {
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

  it("rejects an over-long numeric string, so the panel cannot be flooded", () => {
    expect(safeErrorReference("1".repeat(21))).toBeNull();
    expect(safeErrorReference("1".repeat(20))).toBe("1".repeat(20));
  });

  it("the pattern is anchored, so a valid digest cannot smuggle a suffix", () => {
    expect(NEXT_ERROR_DIGEST_PATTERN.test("3142859661 and then some")).toBe(false);
    expect(NEXT_ERROR_DIGEST_PATTERN.test("3142859661\nchloe@example.com")).toBe(false);
    expect(safeErrorReference("3142859661;/login")).toBeNull();
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
