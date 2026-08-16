import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// PR #200: Last Treatment warning placement + service price default.
//
// 1. The "From last visit, for today" Watch/Plan box renders as a
//    flush footer band INSIDE the Last treatment card (attached
//    variant), omitted cleanly when empty, never duplicated on the
//    Sessions tab.
// 2. The Session payment prepare form defaults its amount from the
//    booked service (client custom pricing wins over the menu price),
//    with source copy and the field still editable. Display default
//    only: no executor, gate, or Stripe-call change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const SUMMARY = read("components/last-session-summary.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");
const RESOLVER = read("lib/billing/session-payment-amount.ts");

// ---------------------------------------------------------------------------
// 1. Watch/Plan box attached to the Last treatment card
// ---------------------------------------------------------------------------

describe("From last visit box is attached to the Last treatment card", () => {
  // The Sessions-tab card region: from the Last treatment heading to
  // the appointment timeline that follows the card.
  const headingIdx = PAGE.indexOf(">Last treatment</h2>");
  const cardRegion = PAGE.slice(
    headingIdx,
    PAGE.indexOf("<ClientAppointmentTimeline", headingIdx),
  );

  it("renders inside the card as a flush footer band (attached variant)", () => {
    expect(cardRegion).toMatch(
      /<FromLastVisitForToday[\s\S]{0,120}attached/,
    );
    // Full-bleed wrapper so the band touches the card's border.
    expect(cardRegion).toMatch(/-mx-5 -mb-5 mt-4/);
    // The attached variant is a top-bordered footer, not a floating
    // island: square top, rounded bottom, border-t only.
    expect(SUMMARY).toMatch(
      /attached\s*\?\s*"rounded-b-lg border-t border-blue-200/,
    );
  });

  it("appears after the area summaries and before the card closes", () => {
    const areas = cardRegion.indexOf("<AreaSummaries");
    const box = cardRegion.indexOf("<FromLastVisitForToday");
    expect(areas).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(areas);
  });

  it("is omitted cleanly when there is no watch/plan content", () => {
    // Host gate (no empty footer margins)...
    expect(cardRegion).toMatch(/hasFromLastVisitContent\(preClientWatchPlan\)/);
    // ...and the component itself still returns null when empty.
    expect(SUMMARY).toMatch(
      /if \(!hasFromLastVisitContent\(summary\)\) \{\s*\n\s*return null;/,
    );
  });

  it("renders exactly once on the Sessions tab (no duplicate warning/plan box)", () => {
    const sessionsTab = PAGE.slice(
      PAGE.indexOf('{activeTab === "sessions"'),
      PAGE.indexOf('{activeTab === "treatment"'),
    );
    expect(sessionsTab.match(/<FromLastVisitForToday/g)?.length).toBe(1);
  });

  it("also renders for the legacy entries fallback, so a plan note is not dropped", () => {
    // The footer band sits OUTSIDE the areas/entries ternary: the
    // entries branch closes before the band renders.
    const entries = cardRegion.indexOf("<LastSessionEntries");
    const box = cardRegion.indexOf("<FromLastVisitForToday");
    expect(entries).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(entries);
  });

  it("old area-level caution data still feeds the Watch lines", () => {
    const helper = read("lib/sessions/clinical-summary.ts");
    expect(helper).toMatch(/caution_for_next_session/);
    expect(helper).toMatch(/watchLines/);
    expect(SUMMARY).toMatch(/Watch:<\/span>/);
    expect(SUMMARY).toMatch(/Plan:<\/span>/);
  });

  it("the other surfaces keep the standalone box (default variant unchanged)", () => {
    const newSession = read("app/(app)/clients/[id]/sessions/new/page.tsx");
    const calendar = read("app/(app)/calendar/[id]/page.tsx");
    expect(newSession).not.toMatch(/<FromLastVisitForToday[\s\S]{0,120}attached/);
    expect(calendar).not.toMatch(/<FromLastVisitForToday[\s\S]{0,120}attached/);
  });
});

// ---------------------------------------------------------------------------
// 2. Session payment default amount (pure resolver, behavioral)
// ---------------------------------------------------------------------------

const TODAY = "2026-06-12";

// The pure pricing resolver moved to lib/billing/session-payment-amount.ts and
// is covered in full by tests/lib/billing/session-payment-amount.test.ts. The
// old display-default resolver is retired: it produced a SUGGESTION the browser
// could edit, and that edit became the charged amount (F-PAY-001).

describe("Session payment prepare form wiring", () => {
  it("the session page resolves the default from appointment + custom pricing and passes it down", () => {
    expect(SESSION_PAGE).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    // BARE-TABLE embed. The old `services:service_id(...)` column hint stopped
    // resolving when migration 0151 replaced the single-column FK with a
    // composite one (PGRST200), so the default was always null here. See
    // tests/app/tenant-consistency-embeds.test.ts for the permanent ban.
    expect(SESSION_PAGE).toMatch(
      /service:services\(name, price_cents, modality\)/,
    );
    // The page no longer assembles pricing itself: no client_pricing read and
    // no local precedence. ONE shared trusted loader serves the page, the
    // quick-checkout modal and the prepare action.
    expect(SESSION_PAGE).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    expect(SESSION_PAGE).toMatch(/amountResult=\{sessionPaymentAmount\}/);
    const pageCode = SESSION_PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(pageCode).not.toMatch(/from\("client_pricing"\)/);
  });

  it("the REFERENCE is rendered by the server decision and is not itself editable", () => {
    // F-PAY-002. The editable control is the FINAL CHARGE, a separate field.
    // What stays true here is that the reference — the booked/client-specific
    // price the server resolved — is rendered, not typed into, and is
    // submitted back only as a stale-display check.
    expect(CARD).toMatch(/formatCadFromCents\(amount\.amountCents\)/);
    const amountRegion = CARD.slice(
      CARD.indexOf('data-testid="authoritative-amount"') - 400,
      CARD.indexOf('data-testid="authoritative-amount"') + 400,
    );
    expect(amountRegion).toMatch(/data-testid="authoritative-amount"/);
    expect(amountRegion).not.toMatch(/<input(?![^>]*type="hidden")/);
    // The legacy unguarded field name never returns.
    expect(CARD).not.toMatch(/name="amount_dollars"/);
    expect(CARD).not.toMatch(/aria-label="Amount in Canadian dollars"/);
    // Submitted only as a stale-display check.
    expect(CARD).toMatch(/name="expected_amount_cents"/);
  });

  it("the final charge sits BELOW the reference, so the reminder reads first", () => {
    // Chloe's words: "It needs to 'soft' show the price of the service so I am
    // reminded what they booked but I also need to be able to change it."
    // Order carries that meaning; a final-charge box above an unexplained
    // number would not.
    const reference = CARD.indexOf('data-testid="authoritative-amount"');
    const finalCharge = CARD.indexOf('name="final_amount_dollars"');
    expect(reference).toBeGreaterThan(-1);
    expect(finalCharge).toBeGreaterThan(reference);
    // And the note field still comes after both.
    expect(CARD.indexOf('name="internal_note"')).toBeGreaterThan(finalCharge);
  });

  it("source copy names the client-specific or booked-service price truthfully", () => {
    expect(CARD).toMatch(/Booked service/);
    expect(CARD).toMatch(/\{amount\.serviceName\}/);
    expect(CARD).toMatch(/Client-specific price for this service\./);
    expect(CARD).toMatch(/Booked service price\./);
    expect(CARD).toMatch(/Custom pricing reminder:/);
    // The old invitation to edit is gone.
    expect(CARD).not.toMatch(/You can adjust before preparing/);
  });

  it("has NO historical session-price fallback — unresolved pricing BLOCKS", () => {
    const cardCode = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(cardCode).not.toMatch(/Suggestion from session price/);
    expect(cardCode).not.toMatch(/pricePaidCents != null/);
    expect(CARD).toMatch(/data-testid="pricing-blocked"/);
    // Review 3780456783 moved this call into the shared presentation decision
    // (lib/billing/ready-control-permission), so the card renders the returned
    // copy instead of recomputing it. The invariant is unchanged: unresolved
    // pricing yields a calm practitioner reason, never a blank box and never a
    // historical-price fallback.
    expect(CARD).toMatch(/presentation\.unresolvedExplanation/);
    const PERM_MSG = readFileSync(
      join(process.cwd(), "lib/billing/ready-control-permission.ts"),
      "utf8",
    );
    expect(PERM_MSG).toMatch(/unresolvedAmountMessage\(amountResult\)/);
  });

  it("prepare copy is neutral (charge happens on run) and nothing implies the client paid", () => {
    expect(CARD).toMatch(
      /This prepares a payment record\. The client is not charged until you\s*\n?\s*run the charge\./,
    );
    expect(CARD).not.toMatch(/already paid|payment received/i);
  });
});

describe("safety: defaulting is display-only", () => {
  it("the resolver imports nothing (pure) and never calls Stripe", () => {
    expect(RESOLVER).not.toMatch(/^import /m);
    expect(RESOLVER).not.toMatch(/require\(/);
    expect(RESOLVER).not.toMatch(/paymentIntents|stripeClient|getStripe/);
  });

  it("prepare/execute actions and the executor are untouched surfaces", () => {
    const actions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    );
    expect(actions).not.toMatch(/resolveSessionPaymentDefault/);
    expect(actions).not.toMatch(/resolveAuthoritativeSessionPaymentAmount\(/);
    expect(
      existsSync(join(process.cwd(), "lib/billing/session-payment-charge.ts")),
    ).toBe(true);
    const executor = read("lib/billing/session-payment-charge.ts");
    expect(executor).not.toMatch(/resolveSessionPaymentDefault/);
  });

  it("the eligibility helper is unchanged by the defaulting path", () => {
    const eligibility = read("lib/billing/session-payment-eligibility.ts");
    expect(eligibility).not.toMatch(/resolveSessionPaymentDefault/);
  });
});
