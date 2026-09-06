import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// COMMS-01A — THE FAMILY GUARD.
//
// The first version of this change added studio identity to the transport and
// wired only one file. Everything went green, because nothing asserted that the
// other CALLERS use it. Clients of six other families kept receiving mail from
// an unrecognised "Hone" with no reply path — the exact defect the change
// claimed to fix.
//
// So this guard does not pin the current call sites. It DISCOVERS every caller
// of every CLIENT EMAIL TRANSPORT and requires each one to either pass
// `studioIdentity` or be explicitly declared Hone-facing below. A newly added
// client-facing caller is in neither set, and fails.
//
// IT ENUMERATES TRANSPORTS, NOT ONE FUNCTION NAME. The first version scanned
// only for `sendEmailSafely({` and therefore could not see
// `sendWaitlistEmailIdempotent`, a SECOND client-facing transport with its own
// hard-coded From. It passed green while a client-facing email still arrived as
// Hone. A guard that cannot see a whole transport is worse than a missing call
// site, because it is the mechanism meant to make missing call sites impossible.
//
//   new caller + studio context + no identity  =>  RED
//
// Adding a name to the allowlist is a deliberate, reviewable act that says
// "this mail is Hone speaking as Hone". Forgetting is not possible.

const ROOT = process.cwd();

/**
 * Every transport that can put mail in front of a CLIENT. Adding a new one
 * without listing it here is caught by `no unlisted client email transport
 * exists` below, so this list cannot silently fall behind the code.
 */
const CLIENT_EMAIL_TRANSPORTS = ["sendEmailSafely", "sendWaitlistEmailIdempotent"] as const;

/** Modules that DEFINE a transport; their own declaration is not a call site. */
const TRANSPORT_DEFINITIONS: Record<string, string> = {
  sendEmailSafely: "lib/email/send-appointment.ts",
  sendWaitlistEmailIdempotent: "lib/email/new-client-waitlist-send.ts",
};

/**
 * Callers that legitimately send UNBRANDED, with the recipient that makes it
 * so. Both go to the STUDIO, not to a client, so branding them "<Studio> via
 * Hone" would be Hone impersonating a studio while writing to that same studio.
 */
// Keyed on the RECIPIENT EXPRESSION, not the enclosing function name. The
// recipient is what makes a send Hone-facing, and a function name is both
// fragile to read (an inner `const` shadows it) and unrelated to the reason.
const HONE_FACING_CALLERS: ReadonlyArray<{ file: string; to: string; why: string }> = [
  {
    file: "lib/email/send-appointment.ts",
    to: "params.practitionerEmail",
    why: "notifies the PRACTITIONER of a new booking; the studio is the reader",
  },
  {
    file: "app/portal/portal-message-actions.ts",
    to: "recipient",
    why: "notifies the STUDIO that a client wrote in; recipient resolves to the studio's own contact address",
  },
  {
    file: "app/book/[slug]/waitlist-actions.ts",
    to: "recipient",
    why: "waitlist namespace:'studio' notification — tells the STUDIO someone joined; the client acknowledgement on the same path IS branded",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

type CallSite = {
  transport: string;
  file: string;
  line: number;
  to: string;
  branded: boolean;
};

function discoverCallSites(): CallSite[] {
  const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))];
  const sites: CallSite[] = [];
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1);
    const src = readFileSync(abs, "utf8");
    const lines = src.split("\n");
    for (const transport of CLIENT_EMAIL_TRANSPORTS) {
      const marker = `${transport}({`;
      if (!src.includes(marker)) continue;
      lines.forEach((l, i) => {
        if (!l.includes(marker)) return;
        // Skip the transport's own declaration line in its defining module.
        if (rel === TRANSPORT_DEFINITIONS[transport] && /export\s+(async\s+)?function/.test(l)) return;
        // The identity, when present, is inside the object literal that follows.
        // The waitlist transport takes a wider argument object, so the window
        // is generous enough to contain it.
        const window = lines.slice(i, i + 14).join("\n");
        const to = window.match(/\bto:\s*([^,\n]+)/);
        sites.push({
          transport,
          file: rel,
          line: i + 1,
          to: (to?.[1] ?? "(unknown)").trim(),
          branded: /studioIdentity\s*:/.test(window),
        });
      });
    }
  }
  return sites;
}

describe("every caller of the canonical email transport is accounted for", () => {
  const sites = discoverCallSites();

  it("discovers call sites at all — the guard is not vacuously green", () => {
    // If the discovery breaks, every assertion below passes trivially. This is
    // the control that stops that.
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(sites.some((s) => s.branded)).toBe(true);
  });

  it("every UNBRANDED caller is explicitly declared Hone-facing", () => {
    const unbranded = sites.filter((s) => !s.branded);
    const undeclared = unbranded.filter(
      (s) => !HONE_FACING_CALLERS.some((h) => h.file === s.file && h.to === s.to),
    );
    expect(
      undeclared.map((s) => `${s.file}:${s.line} -> to: ${s.to}`),
      "A caller of sendEmailSafely passes no studioIdentity and is not declared " +
        "Hone-facing. If it writes to a CLIENT, pass the server-resolved studio " +
        "identity. If it writes to the studio or to Hone, add it to " +
        "HONE_FACING_CALLERS with its recipient.",
    ).toEqual([]);
  });

  it("the Hone-facing allowlist has no stale entries", () => {
    // An allowlist that outlives its call site quietly re-permits the next
    // caller that happens to share the name.
    const stale = HONE_FACING_CALLERS.filter(
      (h) => !sites.some((s) => s.file === h.file && s.to === h.to),
    );
    expect(stale.map((h) => `${h.file} -> to: ${h.to}`)).toEqual([]);
  });

  it("every allowlisted caller documents WHO it writes to", () => {
    for (const h of HONE_FACING_CALLERS) {
      expect(h.why.length, `${h.file} -> ${h.to}`).toBeGreaterThan(0);
      // The justification must name WHO reads it, not offer a vague reason.
      expect(h.why).toMatch(/practitioner|studio|ops|admin/i);
    }
  });
});

describe("the client-facing families are branded", () => {
  const sites = discoverCallSites();
  const brandedIn = (file: string) => sites.filter((s) => s.file === file && s.branded).length;

  // Named families from the COMMS-01A contract. Each must have at least one
  // branded caller; the discovery test above catches anything unlisted.
  const FAMILIES: ReadonlyArray<[string, string]> = [
    ["booking / cancellation / reminders / intake / postcare", "lib/email/send-appointment.ts"],
    ["appointment moved", "lib/email/notify-appointment-moved.ts"],
    ["payment receipt", "lib/billing/payment-receipt.ts"],
    ["portal magic link", "lib/portal/magic-link.ts"],
    ["portal login", "app/portal/login/actions.ts"],
    ["portal message to client", "app/(app)/clients/[id]/portal-messages-actions.ts"],
  ];

  for (const [family, file] of FAMILIES) {
    it(`${family} sends with studio identity`, () => {
      expect(brandedIn(file), `${file} has no branded sendEmailSafely caller`).toBeGreaterThan(0);
    });
  }
});

describe("identity is server-resolved, never client-controlled", () => {
  const sites = discoverCallSites();

  it("no call site derives the display name or reply address from request input", () => {
    for (const s of sites.filter((x) => x.branded)) {
      const src = readFileSync(join(ROOT, s.file), "utf8").split("\n");
      const window = src.slice(s.line - 1, s.line + 8).join("\n");
      // formData / searchParams / req.* / headers are all browser-supplied.
      expect(window, `${s.file}:${s.line}`).not.toMatch(
        /studioIdentity[\s\S]{0,200}?(formData|searchParams|req\.|request\.|headers\(\)|params\.body)/,
      );
      // The recipient's own address must never become the reply address.
      expect(window, `${s.file}:${s.line}`).not.toMatch(/replyTo:\s*[A-Za-z.]*client[A-Za-z.]*/);
    }
  });
});
