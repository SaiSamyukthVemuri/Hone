import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SERVICE_ROLE_ALLOWLIST } from "./service-role-allowlist";

// A SPELLING TRIPWIRE, not a proof. service-role-allowlist.test.ts already pins every createAdminClient() call site and requires a
// scopeGuard string in the file. That string can be anything. This test adds one narrower question for the files a request can reach:
// does an entry point (a route, page, layout or "use server" file) that holds the service role carry a recognised ACTOR GATE, so that a
// signed-in user with no practitioner row (a receptionist, an invited member who has not joined, a client portal session reaching the wrong
// code) cannot be served by it? Helper files are not entry points; their exposure is their callers', and those callers are checked here.
//
// What it cannot see: a gate token that is present but not on the path that reaches the service client, a gate named in a way not listed
// here, and an entry point that reaches the service role only through a helper. It strips comments before matching, so a token that appears
// only in a comment does not count. A new unmatched entry point fails until it carries a listed gate or is added to GATE_EXCEPTIONS with a
// reason a reviewer accepts.

const REPO_ROOT = path.resolve(__dirname, "../..");

export const GATES: Record<string, RegExp> = {
  practitioner_or_owner: /\b(requirePractitionerWithStudio|getCurrentPractitionerWithStudio|resolveActivePractitioner|requireActivePractitioner|requireOwner|assertOwner|isStudioOwner|requireStudioOwner)\b/,
  platform_admin: /\b(isAdmin|requirePlatformAdmin)\s*\(/,
  portal_session: /\b(getCurrentPortalSession|requirePortalSessionForAction)\b/,
  token_proof: /\b(verifyIntakeToken|verifyCancellationToken|hashAppointmentToken|hashCalendarFeedToken|APPOINTMENT_SIGNING_SECRET|token_hash|cancellation_token|hashToken|grant_token|consumeOAuthState|redeem\w*)\b/,
  webhook_signature: /\b(validateTwilioFormRequest|constructEvent|stripe-signature)\b/,
  cron_secret: /\b(CRON_SECRET|isAuthorizedCronRequest)\b/,
};

// Entry points with no listed gate, each with the reason it is acceptable. Keyed by file; a stale entry (file gone, or now carrying a gate) fails.
export const GATE_EXCEPTIONS: Record<string, string> = {
  "app/book/[slug]/page.tsx": "anonymous public booking page by design: no signed-in actor exists to gate; the studio is resolved from the public slug",
  "app/book/[slug]/waitlist-actions.ts": "anonymous public waitlist submission by design (new-client join from the public booking page): no signed-in actor exists to gate; the studio is resolved from the public slug",
  "app/(auth)/login/actions.ts": "pre-session: it authenticates, so there is no actor to gate; reads pending_invitations by the invitee's own email",
  "app/(auth)/accept-invitation/actions.ts": "the invitee is signed in but not yet a member by definition; it binds the invitation to the signed-in user and returns no client data",
};

export function isEntryPoint(file: string, text: string): boolean {
  return /(^|\/)(route|page|layout)\.tsx?$/.test(file) || /^\s*["']use server["']/m.test(text);
}

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function gatesIn(text: string): string[] {
  const code = stripComments(text);
  return Object.entries(GATES).filter(([, rx]) => rx.test(code)).map(([name]) => name);
}

const sites = SERVICE_ROLE_ALLOWLIST.map((e) => e.path).sort();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf8");

describe("entry points that hold the service role carry a recognised actor gate (spelling tripwire)", () => {
  it("every route/page/layout/server-action file in the service-role inventory has a listed gate or a reasoned exception", () => {
    const ungated = sites.filter((p) => {
      const text = read(p);
      return isEntryPoint(p, text) && gatesIn(text).length === 0 && !(p in GATE_EXCEPTIONS);
    });
    expect(ungated, "add a recognised gate, or an accepted reason in GATE_EXCEPTIONS").toEqual([]);
  });

  it("the check looks at real entry points (controls: a known gated action is classified, a known helper is not an entry point)", () => {
    const entry = sites.filter((p) => isEntryPoint(p, read(p)));
    expect(entry.length).toBeGreaterThan(30);
    expect(sites.length).toBeGreaterThan(entry.length);
    const gated = entry.filter((p) => gatesIn(read(p)).length > 0);
    expect(gated.length).toBeGreaterThan(30);
  });

  it("no exception is stale: each names an existing inventory entry point that still has no listed gate", () => {
    for (const p of Object.keys(GATE_EXCEPTIONS)) {
      expect(sites, `${p} is not in the service-role inventory`).toContain(p);
      const text = read(p);
      expect(isEntryPoint(p, text), `${p} is no longer an entry point`).toBe(true);
      expect(gatesIn(text), `${p} now carries a gate: remove the exception`).toEqual([]);
      expect(GATE_EXCEPTIONS[p].length).toBeGreaterThan(20);
    }
  });

  it("NEGATIVE CONTROL: a planted server action with only a signed-in-user check, or a gate named only in a comment, is NOT gated", () => {
    const planted = `"use server";
import { createAdminClient } from "@/lib/supabase/admin-server";
export async function leak() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return createAdminClient().from("clients").select("name");
}`;
    expect(isEntryPoint("app/x/actions.ts", planted)).toBe(true);
    expect(gatesIn(planted)).toEqual([]);
    const commentOnly = planted.replace("if (!user)", "// await requirePractitionerWithStudio();\n  /* isAdmin( */\n  if (!user)");
    expect(gatesIn(commentOnly)).toEqual([]);
    // Positive controls: the same file with a real gate is classified.
    expect(gatesIn(planted.replace("const {", "await requirePractitionerWithStudio();\n  const {"))).toEqual(["practitioner_or_owner"]);
    expect(gatesIn(planted.replace("if (!user)", "if (!isAdmin(user?.email))"))).toEqual(["platform_admin"]);
    // A helper (no route/page/layout name, no "use server") is not an entry point.
    expect(isEntryPoint("lib/x/helper.ts", planted.replace('"use server";', ""))).toBe(false);
  });
});
