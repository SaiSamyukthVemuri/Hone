import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

// REL-001 / REL-014. What the boundaries actually RENDER.
//
// These assertions run the real components through react-dom/server rather than
// grepping their source, so a future refactor that reintroduces `{error.message}`
// fails here even if it phrases it differently. The three mocks below stand in
// for browser-only Next/Sentry plumbing that has no server render; none of them
// touches the copy, the reference logic or the leak surface under test.

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: {
      href: string;
      className?: string;
      children?: ReactNode;
    }) =>
      react.createElement(
        "a",
        { href: props.href, className: props.className },
        props.children,
      ),
  };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const AuthenticatedAreaError = (await import("@/app/(app)/error")).default;
const GlobalError = (await import("@/app/global-error")).default;

// Text shaped exactly like what a real Hone loader throws. lib/** builds 78
// messages as `Failed to load <thing>: ${error.message}`, so the raw PostgREST
// text, and anything it quotes, is genuinely inside error.message.
const SECRET_MESSAGE =
  'Failed to load clients: relation "clients" does not exist for chloe@example.com (LEAK-CANARY-A1)';
const SECRET_STACK = [
  "Error: " + SECRET_MESSAGE,
  "    at getClientsForStudio (/var/task/lib/supabase/queries.ts:235:20)",
  "    at ClientsPage (/var/task/app/(app)/clients/page.tsx:41:3)",
].join("\n");

function failure(digest?: unknown): Error & { digest?: string } {
  const error = new Error(SECRET_MESSAGE);
  error.stack = SECRET_STACK;
  if (digest !== undefined) {
    Object.assign(error, { digest });
  }
  return error as Error & { digest?: string };
}

function renderBoundary(digest?: unknown): string {
  return renderToStaticMarkup(
    createElement(AuthenticatedAreaError, {
      error: failure(digest),
      reset: () => undefined,
    }),
  );
}

function renderGlobal(digest?: unknown): string {
  return renderToStaticMarkup(
    createElement(GlobalError, { error: failure(digest) }),
  );
}

const RENDERERS: Array<[string, (digest?: unknown) => string]> = [
  ["app/(app)/error.tsx", renderBoundary],
  ["app/global-error.tsx", renderGlobal],
];

describe("no boundary renders raw error detail", () => {
  for (const [name, render] of RENDERERS) {
    it(`${name} renders neither the message nor the stack`, () => {
      // Rendered WITH a digest, so this is not passing merely because the
      // component bailed out early.
      const html = render("3142859661");

      expect(html).not.toContain("LEAK-CANARY-A1");
      expect(html).not.toContain("relation");
      expect(html).not.toContain("does not exist");
      expect(html).not.toContain("chloe@example.com");
      expect(html).not.toContain("Failed to load clients");
      expect(html).not.toContain("queries.ts");
      expect(html).not.toContain("/var/task");
      expect(html).not.toContain("    at ");
      expect(html).not.toContain("Error:");
      // And the reference it DID render proves the render was not a no-op.
      expect(html).toContain("3142859661");
    });

    it(`${name} is not vacuous: the error really did carry the secret`, () => {
      // Guards against a future edit that makes `failure()` harmless and turns
      // every assertion above into a tautology.
      const e = failure("1");
      expect(e.message).toContain("LEAK-CANARY-A1");
      expect(e.stack).toContain("queries.ts");
      expect(e.stack).toContain("    at ");
    });
  }
});

describe("the support reference is shown only when it is safe", () => {
  for (const [name, render] of RENDERERS) {
    it(`${name} shows the digest when present`, () => {
      const html = render("3142859661");
      expect(html).toContain("Reference: 3142859661");
    });

    it(`${name} shows a digest carrying Next's error-code suffix`, () => {
      expect(render("3142859661@E394")).toContain("Reference: 3142859661@E394");
    });

    it(`${name} shows NO reference when the digest is absent`, () => {
      const html = render(undefined);
      expect(html).not.toContain("Reference");
      // The specific regression this guards: a template that always renders,
      // producing "Reference: undefined".
      expect(html).not.toContain("undefined");
      expect(html).not.toContain("null");
      expect(html).not.toContain("NaN");
      // The rest of the screen still works without one.
      expect(html).toContain("Something went wrong");
    });

    it(`${name} shows NO reference for an empty or whitespace digest`, () => {
      for (const digest of ["", "   "]) {
        const html = render(digest);
        expect(html, JSON.stringify(digest)).not.toContain("Reference");
      }
    });

    it(`${name} shows NO reference for a routing digest that carries a URL`, () => {
      const html = render("NEXT_REDIRECT;replace;/login;307;");
      expect(html).not.toContain("Reference");
      expect(html).not.toContain("/login");
      expect(html).not.toContain("NEXT_REDIRECT");
    });

    it(`${name} shows NO reference for free-form or PII-bearing text`, () => {
      for (const digest of [
        "chloe@example.com",
        "Failed to load clients: permission denied",
        "d9b4f0e2-1c3a-4f5b-8e7d-2a1b3c4d5e6f",
        "<script>alert(1)</script>",
        // Codex review, PR #580: numeric, but far outside the uint32 range Next
        // can emit, so it is data rather than a digest.
        "4111111111111111",
        "90071992547409910",
      ]) {
        const html = render(digest);
        expect(html, digest).not.toContain("Reference");
        expect(html, digest).not.toContain(digest);
      }
    });

    it(`${name} shows NO reference for a non-string digest from JSON transport`, () => {
      for (const digest of [12345, { a: 1 }, ["1"], true]) {
        expect(render(digest)).not.toContain("Reference");
      }
    });
  }
});

// Codex review, PR #580. Both boundaries used to do a bare `error.digest`.
// React passes the boundary whatever was thrown, so `throw null` in a client
// component made the boundary itself raise a TypeError mid-render. That escaped
// to global-error.tsx, which dereferenced identically and also failed, leaving a
// blank document. These render the RAW thrown value, not an Error.
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({ digest: "42" }, {});
  revoke();
  return proxy;
}

describe("a non-Error throw does not break the boundary", () => {
  const THROWN: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["a number", 42],
    ["a plain object", { message: "boom" }],
    ["an object with a hostile digest", { digest: { toString: () => "x" } }],
    // Codex review round 2: the property READ itself can throw.
    [
      "a digest accessor that throws",
      {
        get digest(): string {
          throw new Error("accessor exploded");
        },
      },
    ],
    ["a revoked Proxy", revokedProxy()],
    [
      "a Proxy whose get trap throws",
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap exploded");
          },
        },
      ),
    ],
  ];

  for (const [label, thrown] of THROWN) {
    it(`app/(app)/error.tsx survives ${label}`, () => {
      const render = () =>
        renderToStaticMarkup(
          createElement(AuthenticatedAreaError, {
            error: thrown as Error & { digest?: string },
            reset: () => undefined,
          }),
        );
      expect(render).not.toThrow();
      const html = render();
      expect(html).toContain("Something went wrong");
      expect(html).not.toContain("Reference");
      expect(html).not.toContain("undefined");
    });

    it(`app/global-error.tsx survives ${label}`, () => {
      const render = () =>
        renderToStaticMarkup(
          createElement(GlobalError, {
            error: thrown as Error & { digest?: string },
          }),
        );
      expect(render).not.toThrow();
      const html = render();
      expect(html).toContain("Something went wrong");
      expect(html).toContain("Reload the page");
      expect(html).not.toContain("Reference");
    });
  }
});

describe("the copy is honest about what it can promise", () => {
  for (const [name, render] of RENDERERS) {
    const html = render("3142859661");

    it(`${name} says something went wrong and that it is not the user's fault`, () => {
      expect(html).toContain("Something went wrong");
      expect(html).toContain("could not finish loading this page");
      expect(html).toContain("not something you did");
    });

    it(`${name} limits its data claim to this screen and tells the user to re-check`, () => {
      expect(html).toContain("Nothing was intentionally changed by this screen");
      expect(html).toContain("check that it saved before you rely on it");
    });

    it(`${name} makes no absolute claim that nothing was saved or changed`, () => {
      // A Server Action that throws also lands on a boundary, so neither
      // screen can promise the backend was untouched.
      for (const overpromise of [
        "Nothing was saved",
        "No data was changed",
        "Your data is safe",
        "no changes were made",
        "nothing has been lost",
      ]) {
        expect(html.toLowerCase(), overpromise).not.toContain(
          overpromise.toLowerCase(),
        );
      }
    });

    it(`${name} uses no em dash, matching the runtime source convention`, () => {
      expect(html).not.toContain("—");
      expect(html).not.toContain("–");
    });
  }
});

describe("recovery affordances", () => {
  it("the authenticated boundary offers retry AND a safe destination", () => {
    const html = renderBoundary("3142859661");
    expect(html).toContain("Try again");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Go to Dashboard");
  });

  it("global-error offers a reload, the only recovery available to it", () => {
    // It replaces the whole document, so there is no inner segment left to
    // re-render and no app shell to navigate within.
    const html = renderGlobal("3142859661");
    expect(html).toContain("Reload the page");
    expect(html).toContain("<html");
    expect(html).toContain("<body");
  });

  it("global-error stays environment-neutral, since it also covers public routes", () => {
    // Marketing pages and token-bearing client links inherit the root layout,
    // so this screen must not assume a signed-in practitioner.
    const html = renderGlobal("3142859661");
    expect(html).not.toContain("/dashboard");
    expect(html).not.toContain("Dashboard");
  });
});

describe("the boundary cannot become a data surface", () => {
  it("app/(app)/error.tsx loads nothing and reads no request state", () => {
    // A boundary that fetched would both defeat containment (it can fail the
    // same way) and risk rendering protected data on an error screen.
    const source = readSource("app/(app)/error.tsx");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("@/lib/supabase");
    expect(source).not.toContain("cookies(");
    expect(source).not.toContain("headers(");
    expect(source).not.toContain("fetch(");
  });

  it("app/global-error.tsx loads nothing either", () => {
    const source = readSource("app/global-error.tsx");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("@/lib/supabase");
    expect(source).not.toContain("fetch(");
  });

  it("neither boundary references error.message or error.stack at all", () => {
    for (const file of ["app/(app)/error.tsx", "app/global-error.tsx"]) {
      const code = stripComments(readSource(file));
      expect(code, file).not.toMatch(/error\s*\.\s*message/);
      expect(code, file).not.toMatch(/error\s*\.\s*stack/);
      expect(code, file).not.toMatch(/error\s*\.\s*name/);
      expect(code, file).not.toMatch(/JSON\s*\.\s*stringify\s*\(\s*error/);
      expect(code, file).not.toMatch(/String\s*\(\s*error\s*\)/);
      // The digest is only ever read through the validator.
      expect(code, file).not.toMatch(/\{\s*error\s*\.\s*digest\s*\}/);
    }
  });
});

function readSource(relative: string): string {
  return readFileSync(path.resolve(__dirname, "../../..", relative), "utf8");
}

// Comments in these files legitimately discuss error.message (explaining why it
// is never rendered). Stripping them keeps the pins above from being satisfied,
// or defeated, by prose.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
