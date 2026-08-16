import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// F-PAY-001 containment. The browser used to decide
// payment_charge_attempts.amount_cents. These prove it cannot come back:
// one pricing algorithm, one trusted loader, no browser amount, no historical
// fallback, and the retired resolver gone for good.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ACTION = read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
const CARD = read("components/session-payment-prepare-card.tsx");
const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const QUICK = read("lib/billing/quick-checkout.ts");
const LOADER = read("lib/billing/authoritative-session-payment.ts");

describe("the retired display-default resolver is gone", () => {
  it("the file no longer exists", () => {
    expect(existsSync(path.join(ROOT, "lib/billing/session-payment-default-amount.ts"))).toBe(
      false,
    );
  });

  it("no PRODUCTION code imports or calls the retired exports", () => {
    // Scoped to shipped code. Tests legitimately name the retired symbols in
    // NEGATIVE assertions ("must not appear"), and the docs/audit history
    // legitimately records that it once existed — neither is a live reference.
    const dirs = ["app", "components", "lib"];
    const files: string[] = [];
    const walk = (d: string) => {
      const abs = path.join(ROOT, d);
      let entries: string[] = [];
      try { entries = readdirSync(abs); } catch { return; }
      for (const e of entries) {
        const rel = path.join(d, e);
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx|md)$/.test(e)) files.push(rel);
      }
    };
    dirs.forEach(walk);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) =>
      /resolveSessionPaymentDefault|SessionPaymentDefaultAmount|session-payment-default-amount/.test(
        codeOnly(read(f)),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("exactly ONE session-payment pricing resolver remains", () => {
    const resolver = read("lib/billing/session-payment-amount.ts");
    expect(resolver).toMatch(/export function resolveAuthoritativeSessionPaymentAmount/);
    // The loader and the action call it; nobody reimplements precedence.
    for (const [name, src] of [["page", PAGE], ["quick-checkout", QUICK], ["card", CARD]] as const) {
      expect(codeOnly(src), `${name} must not reimplement precedence`).not.toMatch(
        /effective_from <=|price_cents > 0/,
      );
    }
  });
});

describe("the browser has no LINEAGE authority, and only bounded amount authority", () => {
  // F-PAY-002 restated the boundary rather than moving it. The browser may
  // REQUEST one number — the operator-authored final total — and that request
  // is authorised, bounded and audited by ONE pure decision. It may not supply
  // the studio, the practitioner, the practitioner's ROLE, the client, the
  // card, the consent signature, or any Stripe identifier. Those pins are
  // below and are unchanged.

  it("the legacy unguarded amount_dollars field is never read", () => {
    // The exact pre-F-PAY-001 spelling, which was inserted verbatim.
    expect(codeOnly(ACTION)).not.toMatch(/formData\.get\("amount_dollars"\)/);
    expect(codeOnly(CARD)).not.toMatch(/name="amount_dollars"/);
  });

  it("the requested total reaches the row ONLY through the decision module", () => {
    expect(ACTION).toMatch(/amount_cents: decision\.amountCents,/);
    expect(ACTION).toMatch(/decideCheckoutFinalAmount\(\{/);
    // The raw form value is never inserted, and never coerced on the way past.
    const code = codeOnly(ACTION);
    expect(code).not.toMatch(/amount_cents: finalAmountRaw/);
    expect(code).not.toMatch(/amount_cents:\s*Number\(/);
    expect(code).not.toMatch(/amount_cents:\s*parse/);
    expect(code).not.toMatch(/Math\.round\(/);
  });

  it("the REFERENCE is still re-resolved server-side, with no fallback", () => {
    expect(ACTION).toMatch(/getAuthoritativeSessionPaymentAmount\(/);
    expect(ACTION).toMatch(/const referenceCents = priced\.result\.amountCents;/);
    expect(codeOnly(ACTION)).not.toMatch(/referenceCents\s*=\s*[^;]*\?\?/);
  });

  it("the stale-display comparison exists and compares the two references", () => {
    const DECISION = read("lib/billing/checkout-final-amount.ts");
    expect(DECISION).toMatch(/expectedCents !== referenceCents/);
    // Nothing may substitute the browser's claim for the resolved reference.
    expect(codeOnly(DECISION)).not.toMatch(/referenceCents\s*=\s*expectedCents/);
  });

  it("the owner fact is derived from the authenticated practitioner", () => {
    expect(ACTION).toMatch(/actorIsOwner = practitioner\.role === "owner"/);
    // There is no form field that could vote on it.
    const code = codeOnly(ACTION);
    expect(code).not.toMatch(/formData\.get\("is_owner"\)/);
    expect(code).not.toMatch(/formData\.get\("isOwner"\)/);
    expect(code).not.toMatch(/formData\.get\("role"\)/);
    expect(code).not.toMatch(/formData\.get\("practitioner_role"\)/);
    // ...and the decision module cannot read one either: it is pure and takes
    // the decided boolean as an argument.
    const DECISION = read("lib/billing/checkout-final-amount.ts");
    expect(codeOnly(DECISION)).not.toMatch(/formData|FormData|createClient|supabase/);
  });

  it("the session-payment UI still submits the reference as a hidden check", () => {
    expect(CARD).toMatch(/name="expected_amount_cents"/);
    expect(CARD).toMatch(/type="hidden"/);
  });

  it("both ceilings reject and never clamp", () => {
    // The CONFIGURED reference...
    expect(ACTION).toMatch(
      /referenceCents > SESSION_PAYMENT_AMOUNT_CEILING_CENTS/,
    );
    // ...and the AUTHORED total, inside the parser.
    const PARSER = read("lib/billing/cad-amount.ts");
    expect(PARSER).toMatch(/reason: "above_ceiling"/);
    for (const [name, src] of [
      ["action", ACTION],
      ["decision", read("lib/billing/checkout-final-amount.ts")],
      ["parser", PARSER],
    ] as const) {
      expect(codeOnly(src), `${name} must not clamp`).not.toMatch(/Math\.min\(/);
      expect(codeOnly(src), `${name} must not clamp`).not.toMatch(/Math\.max\(/);
    }
  });

  it("no historical session price is a pricing authority", () => {
    for (const [name, src] of [["action", ACTION], ["card", CARD], ["loader", LOADER]] as const) {
      // Both spellings: the DB column AND the eligibility summary's camelCase
      // field. A fallback would realistically be written as the latter.
      expect(codeOnly(src), `${name} (column)`).not.toMatch(/price_paid_cents/);
      expect(codeOnly(src), `${name} (summary)`).not.toMatch(/pricePaidCents/);
    }
  });
});

describe("trusted loading and lineage", () => {
  it("the loader is server-only and verifies full lineage", () => {
    expect(LOADER).toMatch(/import "server-only"/);
    expect(LOADER).toMatch(/\.is\("deleted_at", null\)/);
    expect(LOADER).toMatch(/\.eq\("id", appointmentId\)/);
    expect(LOADER).toMatch(/\.eq\("studio_id", args\.studioId\)/);
    // Scoped to the APPOINTMENT query: the same client_id filter also appears
    // on the client_pricing read, so a repo-wide match stayed green even with
    // the appointment's lineage filter deleted.
    const apptQuery = LOADER.slice(
      LOADER.indexOf('from("appointments")'),
      LOADER.indexOf(".maybeSingle()", LOADER.indexOf('from("appointments")')),
    );
    expect(apptQuery).toMatch(/\.eq\("id", appointmentId\)/);
    expect(apptQuery).toMatch(/\.eq\("studio_id", args\.studioId\)/);
    expect(apptQuery).toMatch(/\.eq\("client_id", sessionRow\.client_id as string\)/);
    // Service-studio lineage is enforced by the DATABASE, more strongly than an
    // app-level equality check: migration 0151's composite (service_id,
    // studio_id) FK means a studio-scoped appointment can only reference a
    // service in the same studio. Selecting studio_id INSIDE the embed also
    // broke PostgREST resolution and returned a null service, which would have
    // blocked every payment — so the check is pinned here instead.
    const MIG = read("supabase/migrations/0151_appointment_tenant_consistency.sql");
    expect(MIG).toMatch(/service_id, studio_id/);
    expect(LOADER).toMatch(/service:services\(name, price_cents\)/);
    expect(LOADER).not.toMatch(/services\(name, price_cents, studio_id\)/);
  });

  it("the appointment is never recovered by client id alone", () => {
    const q = codeOnly(LOADER).slice(
      codeOnly(LOADER).indexOf('from("appointments")'),
      codeOnly(LOADER).indexOf(".maybeSingle()", codeOnly(LOADER).indexOf('from("appointments")')),
    );
    expect(q).toMatch(/\.eq\("id", appointmentId\)/);
    expect(codeOnly(LOADER)).not.toMatch(/from\("appointments"\)[\s\S]{0,300}\.limit\(/);
  });

  it("the prepare action re-loads pricing itself rather than trusting the page", () => {
    const body = ACTION.slice(ACTION.indexOf("export async function prepareSessionPaymentChargeAction"));
    expect(body).toMatch(/await getAuthoritativeSessionPaymentAmount\(\{/);
  });
});

describe("session detail and quick checkout share one authority", () => {
  it("both call the same loader; neither reconstructs pricing", () => {
    expect(PAGE).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    expect(QUICK).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    expect(codeOnly(QUICK)).not.toMatch(/from\("client_pricing"\)/);
    expect(codeOnly(PAGE)).not.toMatch(/from\("client_pricing"\)/);
  });

  it("both render the SAME card, so display cannot diverge", () => {
    const MODAL = read("components/quick-checkout-modal.tsx");
    expect(MODAL).toMatch(/<SessionPaymentPrepareCard/);
    expect(MODAL).toMatch(/amountResult=\{/);
    expect(PAGE).toMatch(/amountResult=\{sessionPaymentAmount\}/);
  });
});

describe("preparation remains the pricing boundary; execution may only REFUSE", () => {
  // The invariant this protects is that execution never DECIDES or CHANGES an
  // amount — the prepared row stays the single charge authority. FREE-01 added
  // a check in the opposite direction: an attempt prepared at a positive price
  // survives its service later becoming free (or losing its price entirely),
  // and execution otherwise works purely from the stored row, so it would
  // charge the stale amount. Review 3777447035 made that check exhaustive:
  // execution now asks for PERMISSION, and only a currently resolved price
  // grants it.
  //
  // Anchor on the DECLARATION. `indexOf` on the bare name matches the comment
  // header ~1.5k characters earlier and silently changes what is under test.
  const execStart = ACTION.indexOf(
    "export async function executeSessionPaymentChargeAction",
  );
  const exec = ACTION.slice(execStart);

  it("execution still takes attempt_id only and never recomputes the amount", () => {
    expect(execStart).toBeGreaterThan(-1);
    expect(exec).toMatch(/attempt_id/);
    // No amount is derived for charging anywhere in the action.
    expect(codeOnly(exec)).not.toMatch(/amountCents/);
    expect(codeOnly(exec)).not.toMatch(/amount_cents/);
    const CHARGE = read("lib/billing/session-payment-charge.ts");
    expect(codeOnly(CHARGE)).not.toMatch(/resolveAuthoritativeSessionPaymentAmount/);
    expect(codeOnly(CHARGE)).not.toMatch(/client_pricing/);
  });

  it("the re-resolved price is used ONLY to decide permission", () => {
    expect(exec).toMatch(/getAuthoritativeSessionPaymentAmount/);
    // The verdict is delegated to the one exhaustive decision, so a new
    // pricing kind cannot quietly become chargeable here.
    expect(exec).toMatch(/decideExecutionPricingPermission\(/);
    expect(exec).toMatch(/if \(!permission\.allow\)/);
    expect(exec).toMatch(/outcome: "blocked"/);
    // and the session id comes from the ATTEMPT ROW, never the browser
    expect(exec).toMatch(/\.select\("session_id"\)/);
    expect(exec).toMatch(/\.eq\("studio_id", studioId\)/);
    // the permission module itself never yields an amount
    const PERM = read("lib/billing/execution-pricing-permission.ts");
    expect(codeOnly(PERM)).not.toMatch(/amountCents|amount_cents/);
  });
});
