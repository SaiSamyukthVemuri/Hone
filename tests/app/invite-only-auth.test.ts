import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// PR #253: invite-only auth + no-studio gate. Source-grep pins on the
// auth surfaces so the invite-only posture cannot silently regress. The
// end-to-end behaviour is proven by e2e/invite-only.spec.ts (no-studio
// user gated to /no-access) and tests/db/invite-only-posture.db.test.ts
// (RLS blocks studio/membership/invitation creation).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("login page: sign-in only, invite-only, no self-serve signup", () => {
  // Collapse whitespace so multi-line JSX copy matches the rendered text.
  const LOGIN = read("app/(auth)/login/page.tsx").replace(/\s+/g, " ");
  const LOGIN_ACTIONS = read("app/(auth)/login/actions.ts");

  it("presents sign-in with explicit invite-only copy", () => {
    expect(LOGIN).toMatch(/Sign in to Hone/);
    expect(LOGIN).toMatch(
      /Invited users only\. Use the email address your studio invitation was sent to\./,
    );
    expect(LOGIN).toMatch(/Need access[\s\S]{0,160}hello@hone\.care/);
  });

  it("has NO self-serve signup / create-studio CTA or copy", () => {
    expect(LOGIN).not.toMatch(/create account|sign up|create studio|start free|start your studio/i);
  });

  it("never auto-creates accounts for uninvited users (magic link gates shouldCreateUser)", () => {
    // Magic-link signups are gated on a pending invitation; password
    // signUp / signInWithPassword paths do not exist.
    expect(LOGIN_ACTIONS).toMatch(/shouldCreateUser/);
    expect(LOGIN).not.toMatch(/signUp\(|signInWithPassword/);
    expect(LOGIN_ACTIONS).not.toMatch(/\.signUp\(/);
  });

  it("there is no public /signup or /register route", () => {
    expect(existsSync(join(process.cwd(), "app/signup"))).toBe(false);
    expect(existsSync(join(process.cwd(), "app/(auth)/signup"))).toBe(false);
    expect(existsSync(join(process.cwd(), "app/register"))).toBe(false);
    expect(existsSync(join(process.cwd(), "app/(auth)/register"))).toBe(false);
  });
});

describe("server-side guards: no-studio users are gated", () => {
  const QUERIES = read("lib/supabase/queries.ts");
  const LAYOUT = read("app/(app)/layout.tsx");
  const MIDDLEWARE = read("lib/supabase/middleware.ts");

  it("requirePractitionerWithStudio redirects (/login for anon, /no-access for no studio)", () => {
    const start = QUERIES.indexOf("export async function requirePractitionerWithStudio");
    const fn = QUERIES.slice(start, QUERIES.indexOf("\nexport async function", start + 1));
    expect(fn).toMatch(/redirect\("\/login"\)/);
    expect(fn).toMatch(/redirect\("\/no-access"\)/);
  });

  it("the app shell layout uses the redirecting guard", () => {
    expect(LAYOUT).toMatch(/requirePractitionerWithStudio\(\)/);
    expect(LAYOUT).not.toMatch(/getCurrentPractitionerWithStudio\(\)/);
  });

  it("getCurrentPractitionerWithStudio remains the throwing backstop for actions", () => {
    const start = QUERIES.indexOf("export async function getCurrentPractitionerWithStudio");
    const fn = QUERIES.slice(start, QUERIES.indexOf("\n// Route-guard variant", start));
    expect(fn).toMatch(/throw new Error\("No active practitioner/);
  });

  it("middleware redirects an authenticated no-studio user to /no-access before any render", () => {
    expect(MIDDLEWARE).toMatch(/pathname !== "\/no-access"/);
    expect(MIDDLEWARE).toMatch(/\.from\("practitioners"\)/);
    expect(MIDDLEWARE).toMatch(/url\.pathname = "\/no-access"/);
    // Anonymous gate to /login is still present.
    expect(MIDDLEWARE).toMatch(/url\.pathname = "\/login"/);
  });
});

describe("the /no-access gate is safe and leaks nothing", () => {
  const PAGE = read("app/(auth)/no-access/page.tsx");
  const ACTIONS = read("app/(auth)/no-access/actions.ts");

  it("renders the invite-only gate copy and only Sign out + Contact Hone actions", () => {
    expect(PAGE).toMatch(/No studio access yet/);
    expect(PAGE).toMatch(/Hone is currently invite-only for supervised studios/);
    expect(PAGE).toMatch(/Sign out/);
    expect(PAGE).toMatch(/Contact Hone/);
    expect(PAGE).toMatch(/mailto:hello@hone\.care/);
  });

  it("does its own auth check: anon -> /login, has-studio -> /dashboard (no loop)", () => {
    expect(PAGE).toMatch(/redirect\("\/login"\)/);
    expect(PAGE).toMatch(/redirect\("\/dashboard"\)/);
    // Must NOT CALL the shell guard (would loop back to /no-access). The
    // comment mentions the name, so match the call form (with paren).
    expect(PAGE).not.toMatch(/requirePractitionerWithStudio\(/);
    expect(PAGE).not.toMatch(/getCurrentPractitionerWithStudio\(/);
  });

  it("renders NO app navigation, reads NO studio data, and is noindex", () => {
    expect(PAGE).not.toMatch(/href="\/clients"|href="\/calendar"|href="\/records"|href="\/settings/);
    expect(PAGE).not.toMatch(/\.from\("(clients|sessions|appointments|records)/);
    // The gate is deliberately not indexed by search engines.
    expect(PAGE).toMatch(/index: false/);
  });

  it("the sign-out action ends the session and returns to /login", () => {
    expect(ACTIONS).toMatch(/auth\.signOut\(\)/);
    expect(ACTIONS).toMatch(/redirect\("\/login"\)/);
  });
});
