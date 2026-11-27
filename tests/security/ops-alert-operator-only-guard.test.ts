import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { isMemberSensitiveAlert } from "@/lib/ops/operator-only";

// HON-125. ops_alerts_member_read (0067) lets every member of a studio read every column of a studio-scoped alert row. The writer
// (lib/ops/alerts.ts) therefore writes an alert that carries money, a Stripe/attempt id or a client id OPERATOR-ONLY
// (studio_id and client_id NULL; lib/ops/operator-only.ts). This guard pins the three things that keep that true:
//   1. lib/ops/alerts.ts is the ONLY place that inserts into ops_alerts, and it writes the ROUTED studio_id/client_id.
//   2. Every recordOpsAlert call that sets studioId and is NOT member-sensitive is on the list below, with the reason it may stay
//      readable by the studio's own members. A new studio-scoped alert must be added here on purpose, after asking whether a
//      studio member should read it. (Sensitive ones need no entry: the writer routes them, including the partial-refund alert in
//      lib/billing/payment-webhook-reconciliation.ts, whose lines are left untouched.)
//   3. A call whose safeDetails is built elsewhere cannot be judged statically; the writer judges it at run time (unit-tested in
//      tests/lib/ops/operator-only.test.ts), and the list of those calls is pinned so a new one is noticed.
// The policy itself (owner-only read) is a migration and a Privacy decision, not part of this change.

const ROOT = process.cwd();
const norm = (p: string) => relative(ROOT, p).split(sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const FILES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))];
const TEXT = new Map(FILES.map((f) => [norm(f), readFileSync(f, "utf8")]));

type Call = { key: string; studio: boolean; typed: Record<string, boolean>; detailKeys: string[]; dynamicDetails: boolean };
const calls: Call[] = [];
for (const f of FILES) {
  const text = readFileSync(f, "utf8");
  if (!/recordOpsAlert/.test(text)) continue;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^recordOpsAlert(Durably)?$/.test(n.expression.text)) {
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const typed: Record<string, boolean> = {};
        let studio = false, event = "?", detailKeys: string[] = [], dynamicDetails = false;
        for (const p of arg.properties) {
          if (ts.isSpreadAssignment(p)) { dynamicDetails = true; continue; }
          const name = p.name?.getText() ?? "?";
          const v = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : null;
          const isNull = !v || v.getText() === "null" || v.getText() === "undefined";
          if (name === "studioId") studio = !isNull;
          if (["clientId", "stripeEventId", "stripePaymentIntentId", "manualFeeAttemptId", "appointmentId"].includes(name)) typed[name] = !isNull;
          if (name === "event" && v) event = v.getText().replace(/\s+/g, " ").replace(/["'`]/g, "").slice(0, 60);
          if (name === "safeDetails" && v) {
            if (ts.isObjectLiteralExpression(v)) {
              for (const q of v.properties) {
                if (ts.isSpreadAssignment(q)) dynamicDetails = true;
                else detailKeys.push(q.name?.getText() ?? "?");
              }
            } else dynamicDetails = true;
          }
        }
        calls.push({ key: `${norm(f)}::${event}`, studio, typed, detailKeys, dynamicDetails });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function sensitive(c: Call): boolean {
  return isMemberSensitiveAlert({
    clientId: c.typed.clientId ? "x" : null,
    stripeEventId: c.typed.stripeEventId ? "x" : null,
    stripePaymentIntentId: c.typed.stripePaymentIntentId ? "x" : null,
    manualFeeAttemptId: c.typed.manualFeeAttemptId ? "x" : null,
    safeDetails: Object.fromEntries(c.detailKeys.map((k) => [k, 1])),
  });
}

// Studio-scoped alerts that stay readable by the studio's own members: failures that name no money, no client, no contact detail and
// carry no provider free text (provider text can echo a recipient's phone number, so those are operator-only). Details here are constants or
// enumerated codes. appointmentId and image ids are records those members can already read under their own RLS.
const STAYS_STUDIO_READABLE = [
  "app/(app)/clients/[id]/images/sign-treatment-image.ts::treatment_image_sign_rejected_invalid_path",
  "app/(app)/clients/[id]/images/sign-treatment-image.ts::treatment_image_sign_failed",
  "app/api/cron/appointment-reminders/route.ts::reminder_send_exhausted",
  "app/api/cron/appointment-reminders/route.ts::reminder_email_accounting_failed",
  "app/api/twilio/message-status/route.ts::sms_delivery_failed",
  "app/book/[slug]/waitlist-actions.ts::sms_send_failed",
  "app/cancel/[token]/actions.ts::cancellation_email_unconfirmed",
  "lib/email/notify-appointment-moved.ts::appointment_move_notification_failed",
  "lib/google-calendar/sync/reconcile-heartbeat.ts::DEAD_ROW_EVENT",
  "lib/notifications/practitioner-notifications.ts::input.event",
  "lib/waitlist/invite-to-book-adapter.ts::sms_send_failed",
];
// Studio-scoped, not statically sensitive, with details built elsewhere: judged at run time by the writer. (A call that is
// sensitive by its typed fields is routed whatever its details hold.)
const DYNAMIC_STUDIO_DETAILS = [
  "lib/google-calendar/sync/reconcile-heartbeat.ts::DEAD_ROW_EVENT",
  "lib/notifications/practitioner-notifications.ts::input.event",
];

describe("ops_alerts is written operator-only when it carries money or a client id (HON-125)", () => {
  it("the census found the calls (positive control)", () => {
    expect(calls.length).toBeGreaterThan(80);
    expect(calls.filter((c) => c.studio).length).toBeGreaterThan(60);
  });

  it("lib/ops/alerts.ts is the only writer, and it writes the routed studio_id and client_id", () => {
    const writers = FILES.filter((f) => /from\(\s*["']ops_alerts["']\s*\)\s*\.insert\(/.test(readFileSync(f, "utf8"))).map(norm);
    expect(writers).toEqual(["lib/ops/alerts.ts"]);
    const src = readFileSync(join(ROOT, "lib/ops/alerts.ts"), "utf8");
    const insert = src.slice(src.indexOf('from("ops_alerts").insert('));
    expect(insert).toMatch(/studio_id:\s*routed\.studioId/);
    expect(insert).toMatch(/client_id:\s*routed\.clientId/);
    expect(insert).toMatch(/safe_details:\s*routed\.safeDetails/);
    expect(insert.slice(0, insert.indexOf("});"))).not.toMatch(/studio_id:\s*input\.studioId|client_id:\s*input\.clientId/);
    expect(src).toMatch(/routeOperatorOnly\(/);
  });

  it("every studio-scoped alert that stays readable by studio members is listed, and carries no money, Stripe id, attempt id or client id", () => {
    const readable = calls.filter((c) => c.studio && !sensitive(c)).map((c) => c.key);
    expect([...new Set(readable)].sort()).toEqual([...STAYS_STUDIO_READABLE].sort());
    for (const c of calls.filter((x) => x.studio && !sensitive(x))) {
      expect(c.typed.clientId ?? false, c.key).toBe(false);
      expect(c.typed.stripePaymentIntentId ?? false, c.key).toBe(false);
      expect(c.typed.stripeEventId ?? false, c.key).toBe(false);
      expect(c.typed.manualFeeAttemptId ?? false, c.key).toBe(false);
    }
  });

  it("studio-scoped calls with details built elsewhere are pinned (the writer judges them at run time)", () => {
    const dyn = calls.filter((c) => c.studio && c.dynamicDetails && !sensitive(c)).map((c) => c.key);
    expect([...new Set(dyn)].sort()).toEqual([...DYNAMIC_STUDIO_DETAILS].sort());
  });

  it("the payment alerts, including the partial-refund one, are judged sensitive (so routed), without editing their files", () => {
    const partial = calls.find((c) => c.key === "lib/billing/payment-webhook-reconciliation.ts::charge_refunded_partial_out_of_band");
    expect(partial?.studio).toBe(true);
    expect(partial && sensitive(partial)).toBe(true);
  });

  // Privacy condition: safe_details.studio_id / client_id (where operator-only alerts keep their lineage) are read only by operator and
  // service-role code. Judged on the SOURCE of every `.from("ops_alerts")` call (its client expression), not on file names alone.
  it("every .from(\"ops_alerts\") read uses the service-role client, and only admin pages and service-role jobs read it", () => {
    type Read = { file: string; receiver: string };
    const reads: Read[] = [];
    for (const [file, text] of TEXT) {
      if (!/ops_alerts/.test(text)) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" &&
          n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === "ops_alerts"
        ) reads.push({ file, receiver: n.expression.expression.getText().replace(/\s+/g, "") });
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(reads.length, "the census found the reads (positive control)").toBeGreaterThan(8);

    // 1. The client expression is one of three service-role shapes, and nothing else (no cookie/session client, no user client).
    const ALLOWED_RECEIVERS = new Set(["admin", "args.admin", "createAdminClient()"]);
    expect(reads.filter((r) => !ALLOWED_RECEIVERS.has(r.receiver)), "a read whose client is not the service-role client").toEqual([]);

    // 2. A bare `admin` is bound to createAdminClient() in that file; `args.admin` is only the stuck-fee sweep, and its only caller passes
    //    createAdminClient().
    for (const r of reads.filter((x) => x.receiver === "admin")) {
      expect(TEXT.get(r.file)!, `${r.file}: admin must be createAdminClient()`).toMatch(/\badmin\s*=\s*(await\s+)?createAdminClient\(\)/);
    }
    expect(reads.filter((r) => r.receiver === "args.admin").map((r) => r.file)).toEqual(["lib/billing/stuck-fee-sweep.ts"]);
    expect(TEXT.get("app/api/cron/stuck-fee-sweep/route.ts")!).toMatch(/sweepStuckFeeAttempts\(\{\s*admin:\s*createAdminClient\(\)\s*\}\)/);

    // 3. Where the reads live: admin pages, or library code run by crons and the writer. Never the signed-in app, booking, portal or token routes.
    const files = [...new Set(reads.map((r) => r.file))].sort();
    expect(files).toEqual([
      "app/admin/ops-alerts/actions.ts",
      "app/admin/ops-alerts/page.tsx",
      "app/admin/payments/manual-review/page.tsx",
      "lib/billing/stuck-fee-sweep.ts",
      "lib/cron/reminder-heartbeat.ts",
      "lib/google-calendar/sync/reconcile-heartbeat.ts",
      "lib/ops/alerts.ts",
      "lib/waitlist/retention-health.ts",
    ]);
    expect(files.filter((f) => f.startsWith("app/") && !/^app\/(admin|api\/cron)\//.test(f))).toEqual([]);
  });
});
