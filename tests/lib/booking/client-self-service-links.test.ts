import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientSelfServiceLinks,
} from "@/lib/booking/client-self-service-policy";
import { buildClientConfirmationEmail } from "@/lib/email/templates/appointment";
import {
  build24hReminderEmail,
  build2hReminderEmail,
} from "@/lib/email/templates/reminders";

// ===========================================================================
// HON-47 slice 3 — a suppressed action's LINK IS NEVER SENT.
// ===========================================================================
//
// 0234 refuses the command; the surfaces withdraw their CTAs; this closes the
// last gap. A link in an email or an SMS is a promise, and a studio that has
// switched an action off should not be making it.
//
// Three things are proved here, and the third is the one a behavioural test
// cannot reach on its own:
//
//   1. the helper suppresses the right link, and never /manage
//   2. every template renders CORRECTLY with a suppressed link — no empty
//      href, no "Cancel" label pointing nowhere, no orphaned button row
//   3. every MINT SITE actually goes through the helper, asserted against the
//      real files. A site that kept building the URL by hand would send the
//      suppressed link and nothing else here would notice.

const ORIGIN = "https://hone.care";
const TOKEN = "abc123";

describe("the helper suppresses exactly what the studio switched off", () => {
  const cases: Array<{
    name: string;
    studio: { client_cancellation_enabled: boolean; client_reschedule_enabled: boolean } | null;
    cancel: boolean;
    reschedule: boolean;
  }> = [
    { name: "both on", studio: { client_cancellation_enabled: true, client_reschedule_enabled: true }, cancel: true, reschedule: true },
    { name: "cancellation off", studio: { client_cancellation_enabled: false, client_reschedule_enabled: true }, cancel: false, reschedule: true },
    { name: "reschedule off", studio: { client_cancellation_enabled: true, client_reschedule_enabled: false }, cancel: true, reschedule: false },
    { name: "both off", studio: { client_cancellation_enabled: false, client_reschedule_enabled: false }, cancel: false, reschedule: false },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      const l = clientSelfServiceLinks({ origin: ORIGIN, token: TOKEN, studio: c.studio });
      expect(l.cancelUrl).toBe(c.cancel ? `${ORIGIN}/cancel/${TOKEN}` : null);
      expect(l.rescheduleUrl).toBe(c.reschedule ? `${ORIGIN}/reschedule/${TOKEN}` : null);
      // NEVER suppressed, in any combination. It is the honest fallback: it
      // mutates nothing and names only the actions it can offer.
      expect(l.manageUrl).toBe(`${ORIGIN}/manage/${TOKEN}`);
    });
  }

  it("a studio row with the columns ABSENT keeps both links", () => {
    // The projection-missed case. Absence must never read as "disabled", or a
    // dropped column would silently stop sending links for every studio.
    const l = clientSelfServiceLinks({ origin: ORIGIN, token: TOKEN, studio: {} });
    expect(l.cancelUrl).not.toBeNull();
    expect(l.rescheduleUrl).not.toBeNull();
  });

  it("a NULL studio keeps both links", () => {
    const l = clientSelfServiceLinks({ origin: ORIGIN, token: TOKEN, studio: null });
    expect(l.cancelUrl).not.toBeNull();
    expect(l.rescheduleUrl).not.toBeNull();
  });

  it("the URLs are byte-identical to what the call sites built before", () => {
    // Suppression is the ONLY intended change. Encoding or a trailing slash
    // would silently alter every link the app has ever sent.
    const l = clientSelfServiceLinks({
      origin: ORIGIN,
      token: TOKEN,
      studio: { client_cancellation_enabled: true, client_reschedule_enabled: true },
    });
    expect(l.cancelUrl).toBe(`${ORIGIN}/cancel/${TOKEN}`);
    expect(l.rescheduleUrl).toBe(`${ORIGIN}/reschedule/${TOKEN}`);
    expect(l.manageUrl).toBe(`${ORIGIN}/manage/${TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// THE RENDERED EMAILS. ops01 required each template to be proved with a
// suppressed link, because "renders correctly with null" is exactly where an
// empty href or a dangling label hides.
// ---------------------------------------------------------------------------

const BASE = {
  clientName: "Synthetic Client",
  studioName: "Test Studio",
  studioAddress: null,
  studioEmail: "owner@synthetic.test",
  practitionerName: null,
  serviceName: "Full Face",
  durationMinutes: 45,
  startsAt: new Date("2026-11-02T17:00:00.000Z"),
  endsAt: new Date("2026-11-02T17:45:00.000Z"),
  timezone: "UTC",
  cancellationUrl: `${ORIGIN}/cancel/${TOKEN}`,
  rescheduleUrl: `${ORIGIN}/reschedule/${TOKEN}`,
  intakeUrl: null,
  portalLoginUrl: null,
  preCareInstructions: null,
  treatmentTimeLine: null,
};

const build =
  (fn: (p: never) => { subject: string; html: string; text: string }) =>
  (over: Record<string, unknown>) =>
    fn({ ...BASE, ...over } as never);

/** Every href the HTML actually contains. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

// EVERY client-facing template that carries these links, so none of them can
// be the one that was missed.
for (const [label, make] of [
  ["confirmation", build(buildClientConfirmationEmail)],
  ["24h reminder", build(build24hReminderEmail)],
  ["2h reminder", build(build2hReminderEmail)],
] as const) {
  describe(`the ${label} email with a suppressed link`, () => {
    it("CONTROL — both links present renders both", () => {
      const { html, text } = make({});
      expect(hrefs(html)).toContain(`${ORIGIN}/cancel/${TOKEN}`);
      expect(hrefs(html)).toContain(`${ORIGIN}/reschedule/${TOKEN}`);
      expect(text).toContain(`${ORIGIN}/cancel/${TOKEN}`);
    });

    it("cancellation suppressed: no cancel href, no Cancel label, no empty href", () => {
      const { html, text } = make({ cancellationUrl: null });
      expect(hrefs(html)).not.toContain(`${ORIGIN}/cancel/${TOKEN}`);
      expect(html).not.toContain("/cancel/");
      // The label must go with the link. A "Cancel" word with no href is the
      // dead button this whole slice exists to prevent.
      expect(html).not.toMatch(/>\s*Cancel\s*</);
      // And no empty href anywhere, which is how a null interpolates.
      expect(hrefs(html)).not.toContain("");
      expect(html).not.toContain('href="null"');
      expect(html).not.toContain("undefined");
      // The plain-text part must not keep the line either.
      expect(text).not.toContain("/cancel/");
      expect(text).not.toMatch(/Cancel:\s*$/m);
      expect(text).not.toMatch(/Need to cancel\?\s*$/m);
      // The reschedule link is untouched.
      expect(hrefs(html)).toContain(`${ORIGIN}/reschedule/${TOKEN}`);
    });

    it("BOTH suppressed: the action row is gone entirely, not left empty", () => {
      const { html, text } = make({
        cancellationUrl: null,
        rescheduleUrl: null,
      });
      expect(html).not.toContain("/cancel/");
      expect(html).not.toContain("/reschedule/");
      expect(hrefs(html)).not.toContain("");
      expect(html).not.toContain('href="null"');
      expect(html).not.toMatch(/>\s*Cancel\s*</);
      expect(html).not.toMatch(/>\s*Reschedule\s*</);
      expect(text).not.toContain("/cancel/");
      expect(text).not.toContain("/reschedule/");
      // The email still has to be a usable email.
      expect(html).toContain("Test Studio");
      expect(text).toContain("Test Studio");
    });
  });
}

// ---------------------------------------------------------------------------
// THE SOURCE CONTRACT — every mint site goes through the helper.
// ---------------------------------------------------------------------------
describe("every minting site decides its links through the helper", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  // Every file that mints a client link for SENDING. A new one must be added
  // here; that is the point — the list is the inventory.
  const MINT_SITES = [
    "lib/booking/booking-notifications.ts",
    "lib/email/notify-appointment-moved.ts",
    "app/book/[slug]/actions.ts",
    "app/reschedule/[token]/actions.ts",
    "app/portal/rebook-actions.ts",
    "app/api/cron/appointment-reminders/route.ts",
  ];

  for (const file of MINT_SITES) {
    it(`${file} imports the helper`, () => {
      expect(read(file)).toContain("clientSelfServiceLinks");
    });

    it(`${file} builds NO cancel or reschedule URL by hand`, () => {
      // The defect this catches: a site that keeps its own template literal
      // sends the suppressed link, and every behavioural test still passes
      // because it exercises a different site.
      const src = read(file);
      const handBuilt = [
        ...src.matchAll(/`\$\{[^`]*?\}\/(cancel|reschedule)\/\$\{/g),
      ].map((m) => m[0]);
      expect(handBuilt, `${file} still hand-builds: ${handBuilt.join(", ")}`).toEqual(
        [],
      );
    });
  }

  it("the moved-appointment notice PROJECTS the flags it reads", () => {
    // It selects named columns rather than `*`, so this one can silently lose
    // the flags — and the helper's `?? true` would then keep sending the link.
    const src = read("lib/email/notify-appointment-moved.ts");
    const embeds = [...src.matchAll(/studio:studios\(([^)]*)\)/g)].map((m) => m[1]);
    expect(embeds.length).toBeGreaterThan(0);
    expect(embeds.some((e) => e.includes("client_reschedule_enabled"))).toBe(true);
  });

  it("the helper lives in the server-only policy module", () => {
    // The flags must be read server-side at mint time. `server-only` makes
    // that structural: a client component cannot import this at all, so no
    // browser-supplied flag can reach the decision.
    const src = read("lib/booking/client-self-service-policy.ts");
    expect(src).toContain('import "server-only"');
    expect(src).toContain("export function clientSelfServiceLinks");
  });
});
