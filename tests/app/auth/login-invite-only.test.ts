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

  it("is a server action using the admin client only for the invite lookup", () => {
    expect(ACTION).toMatch(/^"use server";/);
    expect(ACTION).toMatch(/createAdminClient/);
  });

  it("does not log the email or any request body", () => {
    expect(ACTION_CODE).not.toMatch(/console\./);
  });
});

describe("login page: no direct OTP call remains", () => {
  it("the magic-link handler calls the server action", () => {
    expect(PAGE_CODE).toMatch(
      /await requestPractitionerMagicLinkAction\(email\)/,
    );
  });

  it("signInWithOtp no longer appears in the client page", () => {
    expect(PAGE_CODE).not.toMatch(/signInWithOtp/);
  });
});

describe("invited users still get in (intended invite path intact)", () => {
  it("handle_new_user provisioning moved to sign-in: 0141 supersedes 0081 to a no-op", () => {
    // 0081 was the historical provisioning trigger (invitation -> practitioner +
    // stamped acceptance). Migration 0141 replaces handle_new_user with a NO-OP
    // so Auth-user creation no longer fabricates consent or activates a
    // membership; provisioning + the ONE authoritative acceptance now happen at
    // sign-in (reconcile_my_pending_invitation / admin_accept_pending_invitation).
    const trigger0141 = readFileSync(
      path.resolve(
        __dirname,
        "../../../supabase/migrations/0141_onboarding_invitation_reconciliation.sql",
      ),
      "utf8",
    );
    const fn = trigger0141.match(
      /create or replace function public\.handle_new_user\(\)[\s\S]*?\$\$;/i,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/insert into public\.practitioners/i);
    expect(fn).not.toMatch(/terms_accepted_at/i);
    expect(fn).toMatch(/return new;/i);
    // The invite-only gate is preserved by the reconciliation RPCs.
    expect(trigger0141).toMatch(/admin_accept_pending_invitation/);
  });

  it("the invite action still inserts pending status rows the gate matches on", () => {
    const team = readFileSync(
      path.resolve(
        __dirname,
        "../../../app/(app)/settings/team/actions.ts",
      ),
      "utf8",
    );
    expect(team).toMatch(/status: "pending",/);
  });
});
