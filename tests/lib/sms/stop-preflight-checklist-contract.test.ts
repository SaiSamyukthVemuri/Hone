import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  STOP_PREFLIGHT_CHECKLIST,
  STOP_PREFLIGHT_CHECKLIST_VERSION,
  evaluateInboundStopPreflight,
} from "@/lib/sms/inbound-stop-preflight";

// HON-50 G6, Codex P1 4304864063: THE STOP checklist exists in three places
// that must never drift: the evaluator's output, the TS constant the verdict
// holds records to, and the list 0230's writer accepts. This pins all three.

const ROOT = process.cwd();
const SQL = readFileSync(path.join(ROOT, "supabase/migrations/0230_studio_sms_sender_stop_preflights.sql"), "utf8");
const EVALUATOR = readFileSync(path.join(ROOT, "lib/sms/inbound-stop-preflight.ts"), "utf8");

function sqlChecklist(): string[] {
  const m = SQL.match(/v_checklist_v1 constant text\[\] := array\[([\s\S]*?)\];/);
  expect(m, "0230 must declare v_checklist_v1").not.toBeNull();
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("the SQL checklist IS the TS checklist", () => {
  it("same ids, same order, no duplicates", () => {
    const sql = sqlChecklist();
    expect(sql).toEqual([...STOP_PREFLIGHT_CHECKLIST]);
    expect(new Set(sql).size).toBe(sql.length);
  });

  it("the SQL accepts exactly the TS version, in the writer and the table constraint", () => {
    expect(SQL).toContain(`p_checklist_version <> ${STOP_PREFLIGHT_CHECKLIST_VERSION}`);
    expect(SQL).toContain(`check (checklist_version = ${STOP_PREFLIGHT_CHECKLIST_VERSION})`);
    expect(SQL).toMatch(/jsonb_array_length\(p_checks\) <> cardinality\(v_checklist_v1\)/);
  });

  it("the snapshot carries checklist_version, so the verdict can hold a record to it", () => {
    expect(SQL).toContain("'checklist_version', p.checklist_version,");
  });
});

describe("the evaluator emits EXACTLY the checklist, every time", () => {
  it("every check id the evaluator can produce is in the checklist, and every checklist id is produced", () => {
    const literal = new Set([...EVALUATOR.matchAll(/check\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    expect([...literal].sort()).toEqual([...STOP_PREFLIGHT_CHECKLIST].sort());
  });

  const URL = "https://hone.care/api/twilio/inbound-sms";
  const facts: Array<[string, unknown]> = [
    ["nothing read", { env: {} }],
    ["env only", { env: { TWILIO_WEBHOOK_BASE_URL: "https://hone.care", TWILIO_AUTH_TOKEN: "t" } }],
    [
      "service URL inbound, rules read, none matching",
      {
        env: { TWILIO_WEBHOOK_BASE_URL: "https://hone.care", TWILIO_AUTH_TOKEN: "t" },
        endpointProbe: { status: 405, redirectedTo: null },
        service: { inboundRequestUrl: URL, inboundMethod: "POST", useInboundWebhookOnNumber: false, numberSmsApplicationSid: null, accountSid: "AC1" },
        webhookRules: { matched: false },
      },
    ],
    [
      "number-level inbound",
      {
        env: { TWILIO_WEBHOOK_BASE_URL: "https://hone.care", TWILIO_AUTH_TOKEN: "t" },
        service: { useInboundWebhookOnNumber: true, numberSmsUrl: URL, numberSmsMethod: "POST", numberSmsApplicationSid: null },
      },
    ],
  ];
  it.each(facts)("%s: the ids are the checklist, in order, each once", (_name, f) => {
    const r = evaluateInboundStopPreflight(f as never);
    expect(r.checks.map((c) => c.id)).toEqual([...STOP_PREFLIGHT_CHECKLIST]);
    expect(r.ready).toBe(r.checks.every((c) => c.status === "pass"));
  });
});
