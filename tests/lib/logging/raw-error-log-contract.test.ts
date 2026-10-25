import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// MSG-LOG-RAW-ERROR-2. SOURCE CONTRACT: in every file that adopts
// lib/logging/error-class, no raw error object, message, stack, detail, hint,
// cause, body or raw code reaches a log call. A log line carries dbErrorCode(),
// thrownErrorClass() or a fixed literal instead.
//
// What counts as a log call: console.log/info/warn/error/debug, safeLog.info/
// warn/error, and the file-local forwarders (log, logError, logInternal,
// logSanitized, logSilently, logInternalIntakeError, logIntakeActionFailure).
// The analyzer reads the written value structurally (object properties,
// spreads, conditionals, templates, JSON.stringify, String()), skips the
// allow-listed classifiers, and ignores calls it cannot see into (the census
// in #1106 owns "values the source cannot prove").

const SINK_RE =
  /^(console\.(log|info|warn|error|debug)|safeLog\.(info|warn|error)|log|logError|logInternal|logSanitized|logSilently|logInternalIntakeError|logIntakeActionFailure)$/;
const CLASSIFIERS = new Set(["dbErrorCode", "thrownErrorClass", "safeDbCode"]);
const BAD_PROPS = new Set(["message", "stack", "details", "hint", "cause", "body", "response", "text", "code"]);
const ERROR_LIKE = /^(e|err|error|exception|ex|reason|\w+Err|\w+Error)$/;

function rootIdentifier(node: ts.Expression): string | null {
  let cur: ts.Expression = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

export function rawErrorLogViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  function inspect(node: ts.Node, sink: string): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
      return inspect(node.expression, sink);
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) inspect(p.initializer, sink);
        else if (ts.isShorthandPropertyAssignment(p)) {
          if (ERROR_LIKE.test(p.name.text)) out.push(`${file}:${at(p)} ${sink}: shorthand "${p.name.text}"`);
        } else if (ts.isSpreadAssignment(p)) inspect(p.expression, sink);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach((e) => inspect(e, sink));
    if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue, sink);
      return inspect(node.whenFalse, sink);
    }
    if (ts.isBinaryExpression(node)) {
      inspect(node.left, sink);
      return inspect(node.right, sink);
    }
    if (ts.isTemplateExpression(node)) return void node.templateSpans.forEach((s) => inspect(s.expression, sink));
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (CLASSIFIERS.has(callee)) return; // the only way an error's identity may be logged
      if (callee === "JSON.stringify" && node.arguments[0]) return inspect(node.arguments[0], sink);
      if (callee === "String" && node.arguments[0]) return inspect(node.arguments[0], sink);
      return; // opaque call: not this contract's business
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = rootIdentifier(node);
      const prop = ts.isPropertyAccessExpression(node) ? node.name.text : null;
      if (root && ERROR_LIKE.test(root) && (prop === null || BAD_PROPS.has(prop))) {
        out.push(`${file}:${at(node)} ${sink}: ${node.getText(sf)}`);
      } else if (prop && (prop === "message" || prop === "stack")) {
        out.push(`${file}:${at(node)} ${sink}: ${node.getText(sf)}`);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (ERROR_LIKE.test(node.text)) out.push(`${file}:${at(node)} ${sink}: bare "${node.text}"`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (SINK_RE.test(callee)) node.arguments.forEach((a) => inspect(a, callee));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// The analyzer itself: it must fail on every leaking shape and pass the clean ones.
// ---------------------------------------------------------------------------
describe("the analyzer: RED on every way an error's text reaches a log line", () => {
  const RED: Array<[string, string]> = [
    ["a message in a JSON line", 'console.error(JSON.stringify({ event: "x", message: err.message }));'],
    ["a message beside a code", 'safeLog.error(JSON.stringify({ code: error.code, message: error.message }));'],
    ["an optional-chained message", 'console.error(JSON.stringify({ message: insertErr?.message }));'],
    ["the old ternary", 'console.error(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));'],
    ["String(err)", 'logError("x", { error: String(err) });'],
    ["a stack", 'console.error({ stack: e.stack });'],
    ["a bare error object", 'console.error("failed", error);'],
    ["a shorthand error", 'logInternal("x", { error });'],
    ["a spread error", 'logInternal("x", { ...error });'],
    ["a template with a message", 'console.error(`failed: ${lookupErr.message}`);'],
    ["details and hint", 'logInternal("x", { d: error.details, h: error.hint });'],
    ["a raw code (unvalidated)", 'logInternal("x", { code: error.code });'],
    ["a raw cause", 'console.error({ c: err.cause });'],
    ["a message through the file-local helper", 'logSilently({ event: "x", err_message: error.message });'],
    ["a message through the intake helper", 'logInternalIntakeError("x", { code: lookupErr.code, message: lookupErr.message });'],
    ["a message in a plain two-argument console call", 'console.error("Failed to sync:", updateErr.message);'],
    ["a message on a root that does not look like an error", 'logInternal("x", { m: sendResult.message });'],
    ["a stack on a root that does not look like an error", 'console.error(JSON.stringify({ s: response.stack }));'],
  ];
  it.each(RED)("flags %s", (_name, source) => {
    expect(rawErrorLogViolations("fixture.ts", source).length).toBeGreaterThan(0);
  });

  const CLEAN: Array<[string, string]> = [
    ["a database code", 'console.error(JSON.stringify({ event: "x", code: dbErrorCode(error) }));'],
    ["a thrown class", 'logError("x", { errorClass: thrownErrorClass(err) });'],
    ["a fixed literal note", 'logIntakeActionFailure("x", { note: "expected 1 affected row" });'],
    ["the helper forwarding a validated code", 'safeLog.error(JSON.stringify({ event, code: safeDbCode(detail.code), message: detail.note ?? null }));'],
    ["a plain forwarding helper", "console.error(JSON.stringify({ event, ...detail, timestamp }));"],
    ["a closed category from a result", 'logSanitized("x", { retryable: sendResult.retryable });'],
    ["an id-bearing field that is not error text", 'logInternal("x", { appointmentId: asserted.original.appointment_id });'],
    ["a non-sink call that mentions an error", "const label = describe(error.message);"],
  ];
  it.each(CLEAN)("passes %s", (_name, source) => {
    expect(rawErrorLogViolations("fixture.ts", source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The contract over the real tree.
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}
const ADOPTERS = ["app", "lib"]
  .flatMap((d) => walk(path.join(ROOT, d)))
  .filter((f) => /from "@\/lib\/logging\/error-class"/.test(readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f))
  .sort();

// Every file whose writers these batches classified. A file that stops adopting the helper
// must be removed here on purpose, not silently drop out of the contract.
const MUST_BE_COVERED = [
  "app/(app)/calendar/[id]/manual-fee-actions.ts",
  "app/(app)/calendar/actions.ts",
  "app/(app)/calendar/postcare-auto-send.ts",
  "app/(app)/clients/[id]/intake/actions.ts",
  "app/(app)/clients/[id]/portal-messages-actions.ts",
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
  "app/(app)/clients/[id]/sessions/new/actions.ts",
  "app/(app)/clients/new/actions.ts",
  "app/(app)/dashboard/page.tsx",
  "app/(app)/settings/consent/actions.ts",
  "app/(app)/settings/payments/actions.ts",
  "app/(app)/settings/payments/fee-amounts-actions.ts",
  "app/(app)/settings/payments/page.tsx",
  "app/(app)/settings/payments/refresh/page.tsx",
  "app/(app)/settings/payments/return/page.tsx",
  "app/(app)/settings/studio/actions.ts",
  "app/api/cron/calendar-reconcile/route.ts",
  "app/api/cron/calendar-sync/route.ts",
  "app/api/cron/materialize-recurring-breaks/route.ts",
  "app/api/stripe/webhook/route.ts",
  "app/api/twilio/inbound-sms/route.ts",
  "app/intake/[token]/actions.ts",
  "app/intake/[token]/page.tsx",
  "app/manage/[token]/actions.ts",
  "app/portal/login/actions.ts",
  "app/portal/payment-method-actions.ts",
  "app/portal/portal-message-actions.ts",
  "app/portal/verify/[token]/actions.ts",
  "app/portal/verify/[token]/page.tsx",
  "app/reschedule/[token]/actions.ts",
  "lib/billing/auto-payment-receipt.ts",
  "lib/billing/payment-receipt.ts",
  "lib/billing/payment-refund.ts",
  "lib/billing/session-payment-charge.ts",
  "lib/consent/launch-readiness.ts",
  "lib/consent/queries.ts",
  "lib/consent/sign-consent-form.ts",
  "lib/intake/consent-gate.ts",
  "lib/intake/queries.ts",
  "lib/notifications/practitioner-notifications.ts",
  "lib/payment-methods/card-on-file.ts",
  "lib/payment-methods/queries.ts",
  "lib/portal-messages/queries.ts",
  "lib/portal-messages/replies-queries.ts",
  "lib/portal/queries.ts",
  "lib/rate-limit/public.ts",
];

describe("the contract over the files that adopt lib/logging/error-class", () => {
  it("covers every file this batch classified (a regression cannot drop one out of the contract)", () => {
    for (const f of MUST_BE_COVERED) expect(ADOPTERS, f).toContain(f);
  });

  it.each(ADOPTERS)("%s: no raw error object or message reaches a log call", (file) => {
    expect(rawErrorLogViolations(file, readFileSync(path.join(ROOT, file), "utf8"))).toEqual([]);
  });
});
