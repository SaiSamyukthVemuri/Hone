import { describe, expect, it } from "vitest";
import {
  absorbTransportFailure,
  isServerActionTransportFailure,
} from "@/lib/reliability/server-action-transport";

// SENTRY-FETCH-01. The browser's own "this request could not complete"
// rejection is the ONLY thing a best-effort Server Action write may absorb.
// Everything else must keep reaching the boundary or Sentry exactly as before.

describe("isServerActionTransportFailure — the browser's own transport failure", () => {
  it.each([
    ["Chromium", "Failed to fetch"],
    ["WebKit", "Load failed"],
    ["Gecko", "NetworkError when attempting to fetch resource."],
    // @sentry/core appends the host to these exact messages when the request
    // URL is absolute. Server Actions post to a relative URL today; the
    // decision must not depend on that staying true.
    ["Chromium with Sentry's host suffix", "Failed to fetch (hone.care)"],
    ["WebKit with Sentry's host suffix", "Load failed (localhost:3266)"],
  ])("recognises %s", (_engine, message) => {
    expect(isServerActionTransportFailure(new TypeError(message))).toBe(true);
  });
});

describe("isServerActionTransportFailure — everything else stays a real failure", () => {
  it.each<[string, unknown]>([
    [
      "a Server Component error (generic message, digest)",
      Object.assign(
        new Error(
          "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
        ),
        { digest: "3142859661" },
      ),
    ],
    [
      "a deployment-skew miss (UnrecognizedActionError)",
      Object.assign(new Error('Server Action "7f3a" was not found on the server.'), {
        name: "UnrecognizedActionError",
      }),
    ],
    ["the same words on a plain Error", new Error("Failed to fetch")],
    ["a programming TypeError", new TypeError("Cannot read properties of undefined (reading 'ok')")],
    [
      "a failed chunk import, which is a different failure class",
      new TypeError(
        "Failed to fetch dynamically imported module: https://hone.care/_next/static/chunks/x.js",
      ),
    ],
    ["a body that broke after the response began", new TypeError("network error")],
    ["a message that merely starts the same way", new TypeError("Failed to fetch the dashboard")],
    ["a lookalike plain object", { name: "TypeError", message: "Failed to fetch" }],
    ["a bare string", "Failed to fetch"],
    ["null", null],
    ["undefined", undefined],
  ])("does not absorb %s", (_label, value) => {
    expect(isServerActionTransportFailure(value)).toBe(false);
  });
});

describe("absorbTransportFailure — a rejection handler for best-effort writes", () => {
  it("settles a lost write instead of leaving it to reject unhandled", async () => {
    await expect(
      Promise.reject(new TypeError("Failed to fetch")).catch(absorbTransportFailure),
    ).resolves.toBeUndefined();
  });

  it("keeps every other rejection REJECTED, with the very same value", async () => {
    const real = Object.assign(new Error("An error occurred in the Server Components render."), {
      digest: "42",
    });
    // Identity, not just message: the boundary and Sentry must receive exactly
    // what they received before the handler was attached.
    await expect(Promise.reject(real).catch(absorbTransportFailure)).rejects.toBe(real);

    const bug = new TypeError("Cannot read properties of undefined (reading 'ok')");
    await expect(Promise.reject(bug).catch(absorbTransportFailure)).rejects.toBe(bug);
  });
});
