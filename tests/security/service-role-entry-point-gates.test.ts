import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { SERVICE_ROLE_ALLOWLIST } from "./service-role-allowlist";

// A SPELLING TRIPWIRE, not a proof. service-role-allowlist.test.ts already pins every createAdminClient() call site and requires a
// scopeGuard string in the file; that string can be anything. This test asks one narrower question of the files a request can reach:
// does an entry point (a route, page, layout or "use server" file) that holds the service role, directly or by importing a file that does,
// CALL a recognised actor gate, so that a signed-in user with no practitioner row (a receptionist, an invited member who has not joined) is
// not served by it? Entry points that are anonymous or pre-proof by design are listed in GATE_EXCEPTIONS with a reason.
//
// What it checks, exactly: for each such file, after removing comments, import statements and string literals, one of the gate names below
// appears followed by "(". Nothing more.
// What it does NOT check:
//   * It is per FILE, not per exported action: in a file with many exports one gated action satisfies the whole file.
//   * Gates match identifiers: a call that is never reached, or a gate that is called and ignored, passes.
//   * A gate whose name is not listed here is not recognised (the test fails closed: the file must be listed with a reason).
//   * Hashing or minting a token is deliberately NOT a gate; only verify/resolve/consume calls are. A hashed lookup followed by a miss check
//     cannot be matched reliably by spelling, so those routes are listed as exceptions with a reason.
//   * Files that reach the service role only through a helper are covered only by the caller sweep below, which looks at direct imports of
//     inventory helper files (not entry points) and nothing deeper.

const REPO_ROOT = path.resolve(__dirname, "../..");

export const GATES: Record<string, RegExp> = {
  practitioner_or_owner: /\b(requirePractitionerWithStudio|getCurrentPractitionerWithStudio|resolveActivePractitioner|requireActivePractitioner|requireOwner|assertOwner|isStudioOwner|requireStudioOwner)\s*\(/,
  platform_admin: /\b(isAdmin|requirePlatformAdmin)\s*\(/,
  portal_session: /\b(getCurrentPortalSession|requirePortalSessionForAction)\s*\(/,
  // verify / resolve / consume CALLS only. Hashing or minting a token, or selecting a token_hash column, is not proof.
  token_proof: /\b(verifyIntakeToken|verifyCancellationToken|resolveInvitation|consumeOAuthState)\s*\(/,
  webhook_signature: /\b(validateTwilioFormRequest|constructEvent)\s*\(/,
  cron_secret: /\bisAuthorizedCronRequest\s*\(/,
};

// Entry points with no listed gate, each with the reason it is acceptable. Keyed by file; a stale entry (file gone, now gated, or no longer
// an entry point) fails. A reason is a claim a reviewer read, not a proof; it is not enforced by this test.
export const GATE_EXCEPTIONS: Record<string, string> = {
  "app/book/[slug]/page.tsx": "anonymous public booking page by design: no signed-in actor exists to gate; the studio is resolved from the public slug and no client row is read",
  "app/book/[slug]/waitlist-actions.ts": "anonymous public waitlist join for a NEW client by design: writes through the join RPC and returns only ok or a fixed failure text; rate limited; no existing-client data returned",
  "app/book/[slug]/actions.ts": "anonymous public booking command by design: no signed-in actor exists to gate; it mints the cancellation token of the appointment it creates; existing-client enumeration is closed in the command (reviewed in #1396); rate limited",
  "app/portal/login/actions.ts": "anonymous request for a portal sign-in link by email: pre-proof by definition; it mints a link and returns a neutral response whether or not the email is a client",
  "app/(auth)/login/actions.ts": "pre-session: it authenticates, so there is no actor to gate; it asks whether a pending invitation exists for the typed email and returns only ok or a generic retry",
  "app/(auth)/accept-invitation/actions.ts": "the invitee is signed in but not yet a member by definition; the database RPC (not this action) is the gate: it re-derives the verified email and accepts no email, studio or role from the browser",
  "app/calendar-feed/[token]/route.ts": "anonymous token-keyed feed: the presented token is hashed and looked up, and a miss returns 404 (a hashed lookup followed by a miss check; read by Privacy in the #1399 review)",
  "app/portal/verify/[token]/actions.ts": "anonymous portal sign-in link verification: the token is hashed and looked up, and a miss refuses; it creates the portal session, so there is no session to gate yet",
  "app/portal/verify/[token]/page.tsx": "anonymous landing page for the portal sign-in link: it hashes the presented token and looks it up, and a miss shows the generic expired-link state; no portal session exists yet",
  "app/api/cron/calendar-sync/route.ts": "the cron secret check (isAuthorizedCronRequest) is inside the helper this route calls first, not in the route file (named by Insurance in final451)",
  "app/portal/logout/actions.ts": "destroys the caller's own portal session only; reads and returns no client data",
};

export function isEntryPoint(file: string, text: string): boolean {
  return /(^|\/)(route|page|layout)\.tsx?$/.test(file) || /^\s*["']use server["']/m.test(text);
}

// Comments and string/template literals are removed by a small scanner (not regexes: a "/*" inside a line comment, or "//" inside a string,
// must not swallow real code). A scanner that is confused by an unusual literal (for example a regex containing a quote) can only REMOVE code,
// so it fails closed: a gate call lost this way makes a file red, never green. Import names are not followed by "(", so an import never counts.
export function codeOnly(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < text.length && text[i] !== c) { if (text[i] === "\\") i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function gatesIn(text: string): string[] {
  const code = codeOnly(text);
  return Object.entries(GATES).filter(([, rx]) => rx.test(code)).map(([name]) => name);
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const st = statSync(path.join(REPO_ROOT, rel));
    if (st.isDirectory()) out.push(...listSources(rel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|d)\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const inventory = new Set(SERVICE_ROLE_ALLOWLIST.map((e) => e.path));
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf8");

// Which repo files does `text` (at `file`) import? Resolves "@/..." and relative specifiers to existing .ts/.tsx/index files.
export function importedFiles(file: string, text: string): string[] {
  const specs = [...text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const out: string[] = [];
  for (const s of specs) {
    const base = s.startsWith("@/") ? s.slice(2) : s.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), s)) : null;
    if (!base) continue;
    for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(path.join(REPO_ROOT, cand))) { out.push(cand); break; }
  }
  return out;
}

// The swept set: every entry point that holds the service role itself (inventory) or imports an inventory file directly.
const allSources = [...listSources("app"), ...listSources("lib")];
const swept = allSources.filter((p) => {
  const text = read(p);
  if (!isEntryPoint(p, text)) return false;
  // An importer counts when it imports an inventory HELPER. Importing another entry point (a page importing its own ./actions) is not a
  // second route to the service role: that target is swept on its own.
  return inventory.has(p) || importedFiles(p, text).some((f) => inventory.has(f) && !isEntryPoint(f, read(f)));
});

describe("entry points that hold the service role, or import a file that does, call a recognised actor gate (spelling tripwire)", () => {
  it("every such route/page/layout/server-action file has a listed gate call or a reasoned exception", () => {
    const ungated = swept.filter((p) => gatesIn(read(p)).length === 0 && !(p in GATE_EXCEPTIONS)).sort();
    expect(ungated, "call a recognised gate, or list the file in GATE_EXCEPTIONS with an accepted reason").toEqual([]);
  });

  it("the sweep sees real files (controls: both direct holders and importers, many gated)", () => {
    const direct = swept.filter((p) => inventory.has(p));
    const importersOnly = swept.filter((p) => !inventory.has(p));
    expect(direct.length).toBeGreaterThan(50);
    expect(importersOnly.length).toBeGreaterThan(10);
    expect(swept.filter((p) => gatesIn(read(p)).length > 0).length).toBeGreaterThan(50);
    // The three app/ inventory helpers are not entry points by themselves; their entry-point callers are in the sweep.
    for (const helper of ["app/(app)/clients/[id]/sessions/postcare-auto-send.ts", "app/(app)/clients/[id]/sign-treatment-image.ts"]) {
      if (inventory.has(helper)) expect(isEntryPoint(helper, read(helper))).toBe(false);
    }
  });

  it("no exception is stale: each names an existing swept entry point that still has no listed gate", () => {
    for (const p of Object.keys(GATE_EXCEPTIONS)) {
      expect(existsSync(path.join(REPO_ROOT, p)), `${p} does not exist`).toBe(true);
      const text = read(p);
      expect(isEntryPoint(p, text), `${p} is no longer an entry point`).toBe(true);
      expect(swept, `${p} is no longer in the swept set`).toContain(p);
      expect(gatesIn(text), `${p} now calls a gate: remove the exception`).toEqual([]);
      expect(GATE_EXCEPTIONS[p].length).toBeGreaterThan(20);
    }
  });

  describe("NEGATIVE CONTROLS: each of these planted files is NOT gated", () => {
    const head = `"use server";\nimport { createAdminClient } from "@/lib/supabase/admin-server";\n`;
    const body = `export async function leak() {\n  return createAdminClient().from("clients").select("name");\n}\n`;
    const plant = (extra: string, imports = "") => `${head}${imports}${extra}\n${body}`;

    it("only a signed-in-user check", () => {
      expect(isEntryPoint("app/x/actions.ts", plant(""))).toBe(true);
      expect(gatesIn(plant("const { data: { user } } = await supabase.auth.getUser(); if (!user) return null;"))).toEqual([]);
    });
    it("a gate named only in a comment, or inside a string", () => {
      expect(gatesIn(plant("// await requirePractitionerWithStudio();\n/* isAdmin( */"))).toEqual([]);
      expect(gatesIn(plant('const note = "call requirePractitionerWithStudio() first"; const n2 = `isAdmin(x)`;'))).toEqual([]);
    });
    it("an import-only gate (imported, never called)", () => {
      expect(gatesIn(plant("", 'import { requirePractitionerWithStudio } from "@/lib/supabase/queries";\n'))).toEqual([]);
      expect(gatesIn(plant("", 'import {\n  verifyCancellationToken,\n  resolveInvitation,\n} from "@/lib/booking/tokens";\n'))).toEqual([]);
    });
    it("a mint-only file: a 'redeemed' variable, a token_hash select, hashing a token", () => {
      expect(gatesIn(plant("const redeemedEntryId = null; const h = hashAppointmentToken(t); const hh = hashToken(t);"))).toEqual([]);
      expect(gatesIn(plant('const r = await admin.from("portal_tokens").select("token_hash"); const grant_token = 1;'))).toEqual([]);
      expect(gatesIn(plant("const secret = process.env.APPOINTMENT_SIGNING_SECRET; const c = process.env.CRON_SECRET;"))).toEqual([]);
    });
    it("positive controls: a real call is recognised (so the negatives are not vacuous)", () => {
      expect(gatesIn(plant("await requirePractitionerWithStudio();"))).toEqual(["practitioner_or_owner"]);
      expect(gatesIn(plant("if (!isAdmin(user?.email)) return;"))).toEqual(["platform_admin"]);
      expect(gatesIn(plant("const v = verifyCancellationToken(token);"))).toEqual(["token_proof"]);
      expect(gatesIn(plant("const r = await resolveInvitation(raw);"))).toEqual(["token_proof"]);
      expect(gatesIn(plant("if (!isAuthorizedCronRequest(req)) return;"))).toEqual(["cron_secret"]);
    });
    it("an ungated CALLER of an inventory helper is swept and red; a helper file itself is not an entry point", () => {
      const helperCaller = `"use server";\nimport { doWork } from "@/lib/audit/governed-writes";\nexport async function act() { return doWork(); }\n`;
      expect(isEntryPoint("app/x/actions.ts", helperCaller)).toBe(true);
      expect(importedFiles("app/x/actions.ts", helperCaller)).toContain("lib/audit/governed-writes.ts");
      expect(inventory.has("lib/audit/governed-writes.ts")).toBe(true);
      expect(gatesIn(helperCaller)).toEqual([]);
      expect(isEntryPoint("lib/x/helper.ts", plant("").replace('"use server";', ""))).toBe(false);
    });
  });
});
