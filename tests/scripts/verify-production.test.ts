import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PR #308. Read-only production verification script. The script is an
// operator-run tool (it shells `supabase db query --linked`, which CI can't do),
// so these are source-grep guards that pin its READ-ONLY, no-secret, fail-closed
// contract + that it covers every required check. Behavioral end-to-end runs
// happen on the production-linked Mac, not in CI.

const SCRIPT = readFileSync(
  join(process.cwd(), "scripts/verify-production.mjs"),
  "utf8",
);
// Strip // and /* */ comments so the doc-comment (which names the forbidden
// operations to say it avoids them) can't satisfy or trip the greps.
const CODE = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DOC16 = readFileSync(
  join(process.cwd(), "docs/16_LIVE_PAYMENTS_READINESS.md"),
  "utf8",
);
const DOC10 = readFileSync(
  join(process.cwd(), "docs/10_DEPLOYMENT_AND_ENV.md"),
  "utf8",
);

describe("verify-production: read-only DB access", () => {
  it("reads via `supabase db query --linked`", () => {
    expect(CODE).toMatch(/"db",\s*"query",\s*"--linked"/);
  });
  it("never uses db push / db execute / migration apply", () => {
    expect(CODE).not.toMatch(/db\s+push|"push"/);
    expect(CODE).not.toMatch(/db\s+execute|"execute"/);
    expect(CODE).not.toMatch(/migration\s+(up|repair)|migrations?\s+apply/i);
  });
  it("performs no writes (no INSERT/UPDATE/DELETE/UPSERT/DDL in any query)", () => {
    expect(CODE).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert|drop\s+|alter\s+|create\s+(table|policy|index))\b/i);
  });
  it("selects scalars only — never `select *` or client PII columns", () => {
    expect(CODE).not.toMatch(/select\s+\*/i);
    // No PII columns pulled from any table.
    expect(CODE).not.toMatch(/select[^;]*\b(name|email|phone|first_name|last_name|responses|practitioner_note|token)\b/i);
  });
});

describe("verify-production: no Stripe writes / no email / no cron", () => {
  it("touches Stripe only by spawning the local source-gate script", () => {
    expect(CODE).toMatch(/check-stripe-gates\.mjs/);
    // No Stripe SDK / write API usage.
    expect(CODE).not.toMatch(/require\(['"]stripe['"]\)|from\s+['"]stripe['"]|new\s+Stripe\(/);
    expect(CODE).not.toMatch(/paymentIntents|charges\.create|refunds\.create|checkout\.sessions/);
  });
  it("sends no email", () => {
    expect(CODE).not.toMatch(/resend|sendEmail|sendEmailSafely|Resend\(/i);
  });
  it("triggers no cron and hits no app cron route", () => {
    expect(CODE).not.toMatch(/\/api\/cron|appointment-reminders|CRON_SECRET|fire.*cron/i);
  });
});

describe("verify-production: no secrets / no PII in output", () => {
  it("never console-logs the service-role key or Upstash token", () => {
    expect(CODE).not.toMatch(/console\.[a-z]+\([^)]*(SERVICE_ROLE|process\.env\.UPSTASH|token|SUPABASE_SERVICE)/i);
  });
  it("never prints the raw query rows / warning payload", () => {
    expect(CODE).not.toMatch(/console\.[a-z]+\([^)]*(\.rows|\.warning|JSON\.stringify\(rows)/);
  });
  it("reads only presence of Upstash env, never logs its value", () => {
    expect(CODE).toMatch(/process\.env\.UPSTASH_REDIS_REST_URL/);
    expect(CODE).toMatch(/process\.env\.UPSTASH_REDIS_REST_TOKEN/);
  });
});

describe("verify-production: covers every required check", () => {
  it("derives the expected migration max from the repo (no hardcoded literal)", () => {
    // PR #314: the expected max must NOT be a hardcoded literal (it went stale
    // at "0099" while prod/repo was 0100). It is derived from supabase/
    // migrations/ at run time, and the remote value is read from
    // schema_migrations.
    expect(CODE).not.toMatch(/EXPECTED_MIGRATION_MAX\s*=\s*"\d{4}"/);
    expect(CODE).toMatch(/function deriveExpectedMigrationMax/);
    expect(CODE).toMatch(/EXPECTED_MIGRATION_MAX\s*=\s*deriveExpectedMigrationMax\(\)/);
    expect(CODE).toMatch(/"supabase",\s*"migrations"/);
    expect(CODE).toMatch(/schema_migrations/);
  });

  it("the derived expected max tracks the repo's current migration max", () => {
    // Independently compute the repo max the same way the script does, and pin
    // the current value. When a new migration lands this fails, forcing a
    // conscious review of the pre-live verifier (drift tripwire) — but the
    // SCRIPT itself never goes stale, because it derives at run time.
    const nums = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
      .filter(Boolean)
      .map((m) => (m as RegExpExecArray)[1])
      .sort();
    expect(nums[nums.length - 1]).toBe("0100");
  });
  it("0093 bucket private + policies/trigger", () => {
    expect(CODE).toMatch(/treatment-images/);
    expect(CODE).toMatch(/public = false/);
    expect(CODE).toMatch(/treatment_images_enforce_integrity/);
  });
  it("0097 intake link metadata columns", () => {
    expect(CODE).toMatch(/intake_link_last_sent_at/);
    expect(CODE).toMatch(/intake_link_expires_at/);
    expect(CODE).toMatch(/intake_link_send_count/);
  });
  it("0098 intake reminder columns + indexes + RPC branches", () => {
    expect(CODE).toMatch(/intake_reminder_7d_sent_at/);
    expect(CODE).toMatch(/intake_reminder_3d_claimed_at/);
    expect(CODE).toMatch(/appointments_intake_reminder_7d_window_idx/);
    expect(CODE).toMatch(/claim_email_send/);
    expect(CODE).toMatch(/record_email_result/);
  });
  it("0099 practitioner_note column", () => {
    expect(CODE).toMatch(/practitioner_note/);
  });
  it("RLS on the curated critical tables (incl. payments + record-keeping)", () => {
    for (const t of [
      "clients",
      "appointments",
      "client_intake_forms",
      "sessions",
      "session_blocks",
      "treatment_images",
      "payment_charge_attempts",
      "ops_alerts",
      "record_keeping_audit_events",
    ]) {
      expect(CODE).toContain(`"${t}"`);
    }
    expect(CODE).toMatch(/relrowsecurity/);
  });
  it("critical payment ops-alert count (count only, no bodies)", () => {
    expect(CODE).toMatch(/from ops_alerts/);
    expect(CODE).toMatch(/severity = 'critical'/);
    expect(CODE).toMatch(/resolved_at is null/);
    // count(*) only — never selects the message/detail columns.
    expect(CODE).not.toMatch(/select[^;]*ops_alerts[^;]*\b(message|detail|safe_details|payload)\b/i);
  });
  it("Stripe gates 1/1/0/0 via the existing gate", () => {
    expect(CODE).toMatch(/check-stripe-gates\.mjs/);
  });
  it("reminder heartbeat with the mirrored 45-minute threshold", () => {
    expect(CODE).toMatch(/reminder_cron:last_success/);
    expect(CODE).toMatch(/REMINDER_STALE_AFTER_MINUTES\s*=\s*45/);
  });
});

describe("verify-production: fail-closed", () => {
  it("exits non-zero when any required check FAILs or is INCOMPLETE", () => {
    expect(CODE).toMatch(/failed\.length > 0 \|\| incompletes\.length > 0/);
    expect(CODE).toMatch(/process\.exit\(1\)/);
  });
  it("missing Upstash env is INCOMPLETE (never PASS) and points to /admin", () => {
    expect(CODE).toMatch(/if \(!url \|\| !token\)/);
    expect(CODE).toMatch(/incomplete\(\s*"Reminder scheduler heartbeat"/);
    expect(CODE).toMatch(/\/admin/);
  });
  it("a crash fails closed (catch → NOT VERIFIED, exit 1)", () => {
    expect(CODE).toMatch(/main\(\)\.catch/);
    expect(CODE).toMatch(/NOT VERIFIED/);
  });
  it("distinguishes automated verification from manual dashboard checks", () => {
    expect(CODE).toMatch(/MANUAL checks still required/);
    expect(CODE).toMatch(/PRODUCTION VERIFIED/);
  });
});

describe("verify-production: runbook + cross-reference", () => {
  it("docs/16 §17.13 documents the command + manual checks", () => {
    expect(DOC16).toMatch(/17\.13/);
    expect(DOC16).toMatch(/node --env-file=\.env\.local scripts\/verify-production\.mjs/);
    expect(DOC16).toMatch(/OPS_ALERT_EMAILS/);
    expect(DOC16).toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(DOC16).toMatch(/Stripe dashboard/i);
    expect(DOC16).toMatch(/log sample/i);
    expect(DOC16).toMatch(/PASS.*FAIL.*INCOMPLETE|INCOMPLETE/);
  });
  it("docs/10 cross-references the script", () => {
    expect(DOC10).toMatch(/verify-production\.mjs/);
  });
});
