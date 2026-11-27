import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// HON-123 / HON-122 (Privacy condition on #1827). The free-text fields of the split-payments ledger are owner-written and can hold anything:
//   payment_refunds.reason, visit_external_payments.note, visit_bills.fee_adjustment_reason (and the void reason stored with a transfer).
// They are shown to the owner only. This pins, over the source, that none reaches a log line, an ops alert, Stripe metadata, a receipt or an email, and that the
// set of files allowed to read these tables is exactly the reviewed one, so a new reader must be reviewed on purpose.

const ROOT = process.cwd();
const FREE_TEXT = /\b(reason|note|notes|feeAdjustmentReason|fee_adjustment_reason|failureReason)\b/;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) { if (e !== "node_modules" && e !== ".next") walk(rel, out); }
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel);
  }
  return out;
}

/** Every call whose callee looks like a log, alert or notification, and every object literal key named metadata: the argument text. */
function sinks(file: string): Array<{ kind: string; text: string }> {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const found: Array<{ kind: string; text: string }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^(console\.|logger\.|log[A-Z_]\w*|logInternal|logError|logEvent|captureException|captureMessage|Sentry\.|\w*[Aa]lert\w*|notify\w*|sendEmail\w*|sendMail\w*)/.test(callee))
        found.push({ kind: `call ${callee}`, text: n.arguments.map((a) => a.getText(sf)).join(", ") });
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "metadata") found.push({ kind: "metadata", text: n.initializer.getText(sf) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const HANDLERS = ["lib/billing/payment-partial-refund.ts", "lib/billing/visit-payments.ts", "app/(app)/visit-payment-actions.ts", "lib/billing/billed-visits.ts", "lib/finance/statement-money-read.ts"];

describe("owner-written free text on money records stays private", () => {
  it("no log, alert, notification, email call or Stripe metadata in the ledger code mentions a reason or note", () => {
    // Not vacuous: the refund runner has several log calls and a Stripe metadata object, and the scan must see them.
    expect(sinks("lib/billing/payment-partial-refund.ts").length).toBeGreaterThanOrEqual(4);
    for (const f of HANDLERS) for (const s of sinks(f)) expect(FREE_TEXT.test(s.text), `${f}: ${s.kind}(${s.text.slice(0, 120)})`).toBe(false);
  });

  it("the pending refund handed to the Stripe step carries no reason, and its read does not select one", () => {
    const refund = read("lib/billing/payment-partial-refund.ts");
    const type = refund.slice(refund.indexOf("export type PendingRefundRow"), refund.indexOf("}", refund.indexOf("export type PendingRefundRow")));
    expect(FREE_TEXT.test(type)).toBe(false);
    const src = read("lib/billing/visit-payments.ts");
    const fn = src.slice(src.indexOf("export async function readRefundRow"));
    const sel = /\.select\("([^"]+)"\)/.exec(fn)?.[1] ?? "";
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.split(",").map((c) => c.trim()).filter((c) => FREE_TEXT.test(c))).toEqual([]);
  });

  it("the Stripe refund call sends only the ledger's own ids and the charge reason, never free text", () => {
    const refund = read("lib/billing/payment-partial-refund.ts");
    const at = refund.indexOf("metadata: {", refund.indexOf("createStripeRefund("));
    const block = refund.slice(at, refund.indexOf("}", at));
    expect(block).toContain("hone_charge_reason");
    expect(block.replace(/hone_charge_reason|String\(attempt\.charge_reason\)/g, "")).not.toMatch(FREE_TEXT);
  });

  it("no receipt, receipt document, receipt PDF or email builder reads these tables or columns", () => {
    const files = ["lib/billing/payment-receipt.ts", "lib/billing/auto-payment-receipt.ts", "lib/billing/receipt-document.ts", "lib/billing/receipt-pdf.ts"];
    for (const f of files) expect(/payment_refunds|visit_external_payments|visit_bills|fee_adjustment_reason/.test(read(f)), f).toBe(false);
    for (const f of walk("lib/email")) expect(/payment_refunds|visit_external_payments|visit_bills/.test(read(f)), f).toBe(false);
  });

  it("only the reviewed files read the three ledger tables (a new reader is a review decision)", () => {
    const readers = [...walk("app"), ...walk("lib"), ...walk("components")]
      .filter((f) => !/\.test\./.test(f))
      .filter((f) => /["'`](payment_refunds|visit_external_payments|visit_bills)["'`]/.test(read(f)))
      .map((f) => relative(".", f))
      .sort();
    expect(readers).toEqual([
      "lib/billing/billed-visits.ts",
      "lib/billing/visit-payments.ts",
      "lib/dashboard/other-money-forms.ts",
      "lib/finance/statement-money-read.ts",
    ]);
  });

  it("the free-text columns stay out of the CSV export until the field review says otherwise", () => {
    const reg = read("lib/export/resource-registry.ts");
    for (const t of ["visit_bills", "visit_external_payments", "payment_refunds"]) {
      const at = reg.indexOf(`${t}: {`);
      expect(at, t).toBeGreaterThan(-1);
      expect(reg.slice(at, at + 900), t).toMatch(/NOT included in this CSV export yet/);
    }
  });
});
