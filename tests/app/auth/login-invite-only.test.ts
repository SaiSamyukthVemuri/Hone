import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #189. The login page previously called signInWithOtp from the
// browser with the default shouldCreateUser=true: any visitor who
// typed an email got an auth user on link consumption, and the
// handle_new_user() trigger's no-invite fallback created them a
// brand-new studio. These tests pin the invite-only posture: the
// magic-link request runs through a server action that allows user
// creation ONLY when a pending invitation exists.

const ACTION = readFileSync(
  path.resolve(__dirname, "../../../app/(auth)/login/actions.ts"),
  "utf8",
);
const PAGE = readFileSync(
  path.resolve(__dirname, "../../../app/(auth)/login/page.tsx"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ACTION_CODE = codeOnly(ACTION);
const PAGE_CODE = codeOnly(PAGE);

describe("magic-link server action: invite-gated signup", () => {
  it("looks up a pending invitation case-insensitively before the OTP call", () => {
    expect(ACTION_CODE).toMatch(
      /\.from\("pending_invitations"\)\s*\n?\s*\.select\("id"\)\s*\n?\s*\.ilike\("email", normalized\)\s*\n?\s*\.eq\("status", "pending"\)/,
    );
    const lookupIdx = ACTION_CODE.indexOf('"pending_invitations"');
    const otpIdx = ACTION_CODE.indexOf("signInWithOtp");
    expect(lookupIdx).toBeGreaterThan(-1);
    expect(otpIdx).toBeGreaterThan(lookupIdx);
  });

  it("shouldCreateUser is the invite check result, never a literal true", () => {
    expect(ACTION_CODE).toMatch(/shouldCreateUser: allowSignup,/);
    expect(ACTION_CODE).not.toMatch(/shouldCreateUser: true/);
  });

  it("an invite-lookup error fails CLOSED for signup", () => {
    expect(ACTION_CODE).toMatch(
      /const allowSignup = !inviteError && Boolean\(invite\);/,
    );
  });

  it("email is normalized (trim + lowercase) before the lookup and the OTP call", () => {
    expect(ACTION_CODE).toMatch(
      /const normalized = email\.trim\(\)\.toLowerCase\(\);/,
    );
    expect(ACTION_CODE).toMatch(/email: normalized,/);
  });

  it("the signups-not-allowed rejection collapses into generic success (no enumeration oracle)", () => {
    expect(ACTION_CODE).toMatch(
      /if \(\/signups not allowed\/i\.test\(error\.message\)\) \{\s*\n?\s*return \{ ok: true \};/,
    );
  });

  it("other OTP errors return a generic message, never error.message", () => {
    expect(ACTION_CODE).toMatch(
      /error: "Could not send the sign-in link\. Try again in a moment\.",/,
    );
    expect(ACTION_CODE).not.toMatch(/error: error\.message/);
  });

  it("does not log the email or any request body", () => {
    expect(ACTION_CODE).not.toMatch(/console\./);
  });
});

describe("login page: consent-checkbox copy is invitation confirmation, not legal acceptance", () => {
  // The login checkbox does NOT record Terms/Privacy acceptance (that happens at
  // accept-invitation, against the CURRENT versions). It only confirms the person
  // is using their invited email. The un-ticked-box error and the label must say
  // exactly that — never "agree to the Terms of Service and Privacy Policy", which
  // would be a false claim that ticking it is legal acceptance.
  it("the stale legal-acceptance error string is gone", () => {
    // PAGE_CODE strips // comments (which reference the old phrase as a negative
    // example) so this asserts on shipped strings only.
    expect(PAGE_CODE).not.toMatch(/agree to the Terms of Service and Privacy Policy/i);
    expect(PAGE_CODE).not.toMatch(/Please agree to the Terms/i);
  });
});

describe("login page: no direct OTP call remains", () => {
  it("signInWithOtp no longer appears in the client page", () => {
    expect(PAGE_CODE).not.toMatch(/signInWithOtp/);
  });
});
