import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// SENTRY-BOOKING-ERR-01 (B). What app/book/[slug]/error.tsx actually RENDERS.
//
// The public booking page had no boundary of its own, so a failed studio read
// (the Sentry group "Failed to load studio: TypeError: fetch failed") escaped
// to app/global-error.tsx: the whole document replaced by an unstyled
// last-resort screen. This boundary is the retryable public unavailable state
// that replaces it. The leak, reference and robustness rules are the same ones
// tests/app/reliability/authenticated-error-boundary.test.ts holds the other
// two boundaries to; the copy rules are this surface's own, because a booking
// visitor is not a practitioner and may have just pressed Book.

const transition = vi.hoisted(() => ({ pending: false }));

// Only useTransition is replaced, so the press state can be rendered on the
// server. Everything else is React itself.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () =>
      [transition.pending, (callback: () => void) => callback()] as const,
  };
});

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href, className: props.className }, props.children),
  };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const PublicBookingError = (await import("@/app/book/[slug]/error")).default;

// Shaped like what the page really throws, plus a canary.
const SECRET_MESSAGE =
  "Failed to load studio: TypeError: fetch failed for willow@example.com (LEAK-CANARY-B7)";
const SECRET_STACK = [
  "Error: " + SECRET_MESSAGE,
  "    at getStudioBySlug (/var/task/lib/booking/queries.ts:299:20)",
  "    at PublicBookingPage (/var/task/app/book/[slug]/page.tsx:35:3)",
].join("\n");

function failure(digest?: unknown): Error & { digest?: string } {
  const error = new Error(SECRET_MESSAGE);
  error.stack = SECRET_STACK;
  if (digest !== undefined) Object.assign(error, { digest });
  return error as Error & { digest?: string };
}

// `thrown` has no default on purpose: `undefined` is one of the values under test.
function render(thrown: unknown, pending = false): string {
  transition.pending = pending;
  try {
    return renderToStaticMarkup(
      createElement(PublicBookingError, {
        error: thrown as Error & { digest?: string },
        reset: () => undefined,
      }),
    );
  } finally {
    transition.pending = false;
  }
}

describe("the public booking boundary renders no raw error detail", () => {
  it("renders neither the message nor the stack", () => {
    const html = render(failure("3142859661"));
    for (const leak of [
      "LEAK-CANARY-B7",
      "Failed to load studio",
      "fetch failed",
      "TypeError",
      "willow@example.com",
      "queries.ts",
      "/var/task",
      "    at ",
      "Error:",
    ]) {
      expect(html, leak).not.toContain(leak);
    }
    // ...while the render was real: the validated reference made it through.
    expect(html).toContain("3142859661");
  });

  it("is not vacuous: the error really carried the secret", () => {
    const e = failure("1");
    expect(e.message).toContain("LEAK-CANARY-B7");
    expect(e.stack).toContain("queries.ts");
  });
});

describe("the support reference is shown only when it is safe", () => {
  it("shows a server digest, including one with Next's error-code suffix", () => {
    expect(render(failure("3142859661"))).toContain("Reference: 3142859661");
    expect(render(failure("3142859661@E394"))).toContain("Reference: 3142859661@E394");
  });

  it("shows NO reference for an absent, blank, routing or free-form digest", () => {
    for (const digest of [
      undefined,
      "",
      "   ",
      "NEXT_REDIRECT;replace;/login;307;",
      "willow@example.com",
      "4111111111111111",
      12345,
    ]) {
      const html = render(failure(digest));
      expect(html, String(digest)).not.toContain("Reference");
      expect(html, String(digest)).not.toContain("undefined");
      expect(html, String(digest)).toContain("Booking is unavailable right now");
    }
  });
});

describe("a non-Error throw does not break the boundary", () => {
  const { proxy: revoked, revoke } = Proxy.revocable({ digest: "42" }, {});
  revoke();
  const THROWN: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["a plain object", { message: "boom" }],
    [
      "a digest accessor that throws",
      {
        get digest(): string {
          throw new Error("accessor exploded");
        },
      },
    ],
    ["a revoked Proxy", revoked],
  ];

  for (const [label, thrown] of THROWN) {
    it(`survives ${label}`, () => {
      expect(() => render(thrown)).not.toThrow();
      const html = render(thrown);
      expect(html).toContain("Booking is unavailable right now");
      expect(html).toContain("Try again");
      expect(html).not.toContain("Reference");
    });
  }
});

describe("the copy is honest about what it can promise", () => {
  const html = render(failure("3142859661"));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("names the condition and that it is not the visitor's fault", () => {
    expect(text).toContain("Booking is unavailable right now");
    expect(text).toContain("could not finish loading");
    expect(text).toContain("not something you did");
  });

  it("tells a visitor who had just pressed Book to check before booking again", () => {
    // A booking action that throws lands here too, possibly AFTER the
    // appointment was written. Silence here is how a lost response becomes a
    // double booking.
    expect(text).toContain("If you had just pressed Book");
    expect(text).toContain("may already be booked");
    expect(text).toContain("before you book again");
  });

  it("never claims that nothing was booked or changed", () => {
    for (const overpromise of [
      "nothing was booked",
      "was not booked",
      "no appointment was",
      "nothing was saved",
      "no changes were made",
      "your booking failed",
    ]) {
      expect(text.toLowerCase(), overpromise).not.toContain(overpromise);
    }
  });

  it("does not claim the studio does not exist", () => {
    // The whole point of the 404/500 split: this screen means UNKNOWN.
    for (const absent of ["not found", "does not exist", "no studio", "404"]) {
      expect(text.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it("stays public: no practitioner destinations or vocabulary", () => {
    expect(html).not.toContain("/dashboard");
    expect(text).not.toContain("Dashboard");
    expect(text).not.toContain("saving something");
  });

  it("uses no em or en dash, matching the runtime source convention", () => {
    expect(html).not.toContain("—");
    expect(html).not.toContain("–");
  });
});

describe("the retry control", () => {
  it("is a real button that offers to try again", () => {
    const html = render(failure("3142859661"));
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("focus-visible:ring-2");
  });

  it("acknowledges the press while the retry is in flight (LAW 4)", () => {
    const idle = render(failure("1"), false);
    const pressed = render(failure("1"), true);
    expect(idle).not.toContain("Trying again");
    expect(pressed).toContain("Trying again…");
    expect(pressed).toMatch(/<button[^>]*disabled=""/);
    expect(pressed).toMatch(/<button[^>]*aria-busy="true"/);
  });
});

describe("the boundary cannot become a data surface", () => {
  const SOURCE = readFileSync(
    path.resolve(__dirname, "../../..", "app/book/[slug]/error.tsx"),
    "utf8",
  );
  // Comments here legitimately discuss error.message (explaining why it is
  // never rendered), so prose must neither satisfy nor trip these pins.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("loads nothing and reads no request state", () => {
    for (const forbidden of ["createClient", "@/lib/supabase", "fetch(", "cookies(", "headers("]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("never touches error.message, error.stack or error.name", () => {
    expect(code).not.toMatch(/error\s*\.\s*(message|stack|name)/);
    expect(code).not.toMatch(/String\s*\(\s*error\s*\)/);
    expect(code).not.toMatch(/\{\s*error\s*\.\s*digest\s*\}/);
  });

  it("reports from the browser only what onRequestError cannot see", () => {
    // Server-raised errors are captured by instrumentation.ts already; a second
    // browser copy would arrive with React's elided message and collapse every
    // server failure into one meaningless issue.
    expect(code).toContain("shouldReportRouteErrorFromClient(error)");
    expect(code).toMatch(/if \(!shouldReportRouteErrorFromClient\(error\)\) return;/);
  });
});
