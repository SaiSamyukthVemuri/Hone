import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runStopPreflight, targetAllowed, type AdminLike } from "@/scripts/sms/stop-preflight/run";
import { sanitizeFacts, FACTS_FILE_VERSION } from "@/scripts/sms/stop-preflight/facts";
import { STOP_PREFLIGHT_CHECKLIST, STOP_PREFLIGHT_CHECKLIST_VERSION } from "@/lib/sms/inbound-stop-preflight";

// ===========================================================================
// HON-50 G6 operator script (scripts/sms/record-stop-preflight.mjs): the facts
// file is validated field by field (malformed = not read = unknown), identity
// comes from the database, DRY RUN writes nothing, --record writes exactly the
// evaluator's v1 output with the checked_at compare-and-set, and the output
// carries codes and ids only.
// ===========================================================================

const NOW = Date.parse("2026-10-18T12:00:00Z");
const STUDIO = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";
const NUMBER = "+14165550100";
const MSID = `MG${"c".repeat(32)}`;
const ACCOUNT = `AC${"1".repeat(32)}`;
const BASE = "https://hone.example";
const URL_RETRY = `${BASE}/api/twilio/inbound-sms#ct=1000&rt=5000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`;

/** A facts file that, with the snapshot below, evaluates READY. */
const readyFacts = (): Record<string, unknown> => ({
  factsVersion: FACTS_FILE_VERSION,
  deployment: { webhookBaseUrl: BASE, authTokenSet: true, appOrigin: BASE, accountSid: ACCOUNT },
  signatureProof: { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "2026-10-01T00:00:00Z" },
  endpointProbe: { status: 405, redirectedTo: null },
  // The service and number these facts were read from: must be this sender's.
  service: { sid: MSID, checkedNumber: NUMBER, inboundRequestUrl: URL_RETRY, inboundMethod: "POST", useInboundWebhookOnNumber: false, numberSmsUrl: null, numberSmsApplicationSid: null, accountSid: ACCOUNT },
  webhookRules: { matched: false },
  staticProxyEnabled: false,
  webhookPropagation: { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 3600 },
  liveStopObservation: {
    reachedRoute: true,
    routeStatus: 200,
    phoneWideOptOutStamped: true,
    observedAt: "2026-10-12T12:00:00Z",
    toNumber: NUMBER,
    messagingServiceSid: MSID,
  },
  optOutConfiguration: { dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" },
  currentActivation: { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" },
});

type Call = { fn: string; args: Record<string, unknown> };
function fakeAdmin(over: {
  snapshot?: unknown;
  snapshotError?: boolean;
  mapped?: string | null;
  record?: () => { data: unknown; error: unknown };
  recordThrows?: boolean;
} = {}) {
  const calls: Call[] = [];
  const admin: AdminLike = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "get_live_studio_sms_sender_registration_state") {
        if (over.snapshotError) return { data: null, error: { code: "57014" } };
        return {
          data:
            over.snapshot ??
            {
              senders: [{ id: SENDER, studio_id: STUDIO, status: "active", phone_number: NUMBER, messaging_service_sid: MSID, provisioned_at: "2026-10-01T00:00:00Z" }],
              registrations: [],
              campaign_bindings: [],
              stop_preflights: [],
            },
          error: null,
        };
      }
      if (fn === "resolve_studio_by_sms_messaging_service") return { data: over.mapped === undefined ? STUDIO : over.mapped, error: null };
      if (fn === "record_studio_sms_stop_preflight") {
        if (over.recordThrows) throw new Error("socket hang up");
        return over.record ? over.record() : { data: [{ result: "recorded", preflight_id: "p-1" }], error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { admin, calls };
}

const run = (admin: AdminLike, raw: unknown, mode: "dry_run" | "record" = "dry_run") =>
  runStopPreflight({ admin, studioId: STUDIO, raw, mode, context: "cutover", nowMs: NOW });

describe("DRY RUN (the default) evaluates and writes nothing", () => {
  it("a complete, proven facts file evaluates READY with the complete v1 checklist", async () => {
    const { admin, calls } = fakeAdmin();
    const r = await run(admin, readyFacts());
    expect(r).toMatchObject({ result: "evaluated", ready: true, senderId: SENDER, malformed: [], ignored: [] });
    expect(r.checks?.map((c) => c.id)).toEqual([...STOP_PREFLIGHT_CHECKLIST]);
    expect(calls.some((c) => c.fn === "record_studio_sms_stop_preflight")).toBe(false);
  });

  // 924-T1: the non-ready paths must not record either; a dry run that wrote
  // only when NOT ready would pass the READY case above.
  it("a well-formed facts file that evaluates NOT ready records nothing", async () => {
    const { admin, calls } = fakeAdmin();
    const r = await run(admin, { ...readyFacts(), staticProxyEnabled: true });
    expect(r).toMatchObject({ result: "evaluated", ready: false, malformed: [] });
    expect(calls.some((c) => c.fn === "record_studio_sms_stop_preflight")).toBe(false);
  });

  it("a malformed facts file records nothing", async () => {
    const { admin, calls } = fakeAdmin();
    const facts = readyFacts();
    (facts.liveStopObservation as Record<string, unknown>).toNumber = "416-555-0100";
    const r = await run(admin, facts);
    expect(r).toMatchObject({ result: "evaluated", ready: false });
    expect(r.malformed?.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.fn === "record_studio_sms_stop_preflight")).toBe(false);
  });
});

describe("--record writes EXACTLY the evaluator's v1 output, guarded by the CAS", () => {
  it("records the checklist ids and statuses, version 1, the snapshot's identity, and the CAS read first", async () => {
    const prior = "2026-10-15T09:00:00.123456+00:00";
    const { admin, calls } = fakeAdmin({
      snapshot: {
        senders: [{ id: SENDER, studio_id: STUDIO, status: "active", phone_number: NUMBER, messaging_service_sid: MSID, provisioned_at: "2026-10-01T00:00:00Z" }],
        registrations: [],
        campaign_bindings: [],
        stop_preflights: [
          { sender_id: SENDER, studio_id: STUDIO, phone_number: NUMBER, messaging_service_sid: MSID, ready: false, checklist_version: 1, checks: [], webhook_base: BASE, credentials_epoch: null, checked_at: prior },
        ],
      },
    });
    const r = await run(admin, readyFacts(), "record");
    expect(r.result).toBe("recorded");
    const rec = calls.find((c) => c.fn === "record_studio_sms_stop_preflight")!;
    expect(rec.args).toMatchObject({
      p_studio_id: STUDIO,
      p_expected_sender_id: SENDER,
      p_expected_phone: NUMBER,
      p_messaging_service_sid: MSID,
      p_checklist_version: STOP_PREFLIGHT_CHECKLIST_VERSION,
      p_webhook_base: BASE,
      p_context: "cutover",
      p_expected_checked_at: prior,
      p_credentials_active_since: "2026-10-01T00:00:00Z",
    });
    expect(rec.args.p_checks).toEqual(r.checks);
    expect((rec.args.p_checks as Array<{ id: string }>).map((c) => c.id)).toEqual([...STOP_PREFLIGHT_CHECKLIST]);
  });

  it("a NOT-ready evaluation is recorded as such (it replaces a stale ready); the writer derives ready", async () => {
    const facts = readyFacts();
    (facts.optOutConfiguration as Record<string, unknown>).dropsKeywordMessages = true;
    const { admin, calls } = fakeAdmin();
    const r = await run(admin, facts, "record");
    expect(r).toMatchObject({ result: "recorded", ready: false });
    expect(calls.find((c) => c.fn === "record_studio_sms_stop_preflight")).toBeTruthy();
  });

  it("a stale CAS is refused and reported, never overwritten", async () => {
    const { admin } = fakeAdmin({ record: () => ({ data: [{ result: "preflight_changed", preflight_id: null }], error: null }) });
    expect(await run(admin, readyFacts(), "record")).toMatchObject({ result: "record_refused", code: "preflight_changed" });
  });

  it("a lost answer (thrown, an error, or no row) is outcome_unknown, never 'not recorded'", async () => {
    expect((await run(fakeAdmin({ recordThrows: true }).admin, readyFacts(), "record")).result).toBe("outcome_unknown");
    expect((await run(fakeAdmin({ record: () => ({ data: null, error: { code: "57014" } }) }).admin, readyFacts(), "record")).result).toBe("outcome_unknown");
    expect((await run(fakeAdmin({ record: () => ({ data: [], error: null }) }).admin, readyFacts(), "record")).result).toBe("outcome_unknown");
  });

  it("without a webhook base nothing is recorded (the record would fail base_changed anyway)", async () => {
    const facts = readyFacts();
    delete (facts.deployment as Record<string, unknown>).webhookBaseUrl;
    const { admin, calls } = fakeAdmin();
    expect((await run(admin, facts, "record")).result).toBe("cannot_record_without_webhook_base");
    expect(calls.some((c) => c.fn === "record_studio_sms_stop_preflight")).toBe(false);
  });
});

describe("identity comes from the DATABASE, never the facts file", () => {
  it("the file's routedFromNumber and studio ids are ignored and reported (the database decides them)", async () => {
    const facts: Record<string, unknown> = { ...readyFacts(), routedFromNumber: "+14165550199", mappedStudioId: STUDIO, expectedStudioId: STUDIO };
    const { admin } = fakeAdmin();
    const r = await run(admin, facts);
    expect(r).toMatchObject({ result: "evaluated", ready: true });
    expect(r.ignored?.sort()).toEqual(["expectedStudioId", "mappedStudioId", "routedFromNumber"]);
  });

  // Codex P2 4305512201: service facts copied from ANOTHER Messaging Service
  // or number must never be combined with this sender's identity.
  it.each<[string, Record<string, unknown>, string]>([
    ["read from another Messaging Service", { sid: `MG${"d".repeat(32)}` }, "service_evidence_for_another_sender"],
    ["read from another number", { checkedNumber: "+14165550199" }, "service_evidence_for_another_sender"],
    ["not labelled with the service it describes", { sid: undefined }, "service_evidence_unlabelled"],
    ["not labelled with the number it describes", { checkedNumber: undefined }, "service_evidence_unlabelled"],
  ])("service facts %s: every service fact and the opt-out setting are dropped, so nothing passes on them", async (_n, change, code) => {
    const facts = readyFacts();
    const svc = facts.service as Record<string, unknown>;
    for (const [k, v] of Object.entries(change)) {
      if (v === undefined) delete svc[k];
      else svc[k] = v;
    }
    const { admin, calls } = fakeAdmin();
    const r = await run(admin, facts, "record");
    expect(r.malformed).toContain(code);
    expect(r.ready).toBe(false);
    for (const id of ["inbound_reaches", "stop_redelivery", "signing_account"]) {
      expect(r.checks?.find((c) => c.id === id)?.status, id).not.toBe("pass");
    }
    // The opt-out setting is per service: unbound, so stop_forwarded cannot pass.
    expect(r.checks?.find((c) => c.id === "stop_forwarded")?.status).not.toBe("pass");
    // A not-ready record is still a truthful record.
    expect((calls.find((c) => c.fn === "record_studio_sms_stop_preflight")!.args.p_checks as Array<{ status: string }>).some((c) => c.status !== "pass")).toBe(true);
  });

  it("the service mapped to ANOTHER studio fails studio_mapping", async () => {
    const r = await run(fakeAdmin({ mapped: "99999999-9999-4999-8999-999999999999" }).admin, readyFacts());
    expect(r.checks?.find((c) => c.id === "studio_mapping")?.status).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it.each([
    ["an unreadable snapshot", { snapshotError: true }, "snapshot_unreadable"],
    ["no active sender", { snapshot: { senders: [], registrations: [] } }, "no_active_sender"],
    [
      "two active senders",
      {
        snapshot: {
          senders: [
            { id: SENDER, studio_id: STUDIO, status: "active", phone_number: NUMBER, messaging_service_sid: MSID },
            { id: "44444444-4444-4444-8444-444444444444", studio_id: STUDIO, status: "active", phone_number: "+14165550101", messaging_service_sid: MSID },
          ],
          registrations: [],
        },
      },
      "ambiguous_active_sender",
    ],
    ["a sender with no service", { snapshot: { senders: [{ id: SENDER, studio_id: STUDIO, status: "active", phone_number: NUMBER, messaging_service_sid: null }], registrations: [] } }, "sender_identity_missing"],
  ])("%s → %s, nothing evaluated or recorded", async (_n, over, result) => {
    const { admin, calls } = fakeAdmin(over as never);
    expect((await run(admin, readyFacts(), "record")).result).toBe(result);
    expect(calls.some((c) => c.fn === "record_studio_sms_stop_preflight")).toBe(false);
  });
});

describe("the facts file: secrets refused, every field validated (malformed = unknown, never pass)", () => {
  it.each([
    ["an auth token value", { deployment: { TWILIO_AUTH_TOKEN: "abc123" } }],
    ["a nested secret", { service: { apiKey: "sk_live_x" } }],
    ["a password", { password: "hunter2" }],
  ])("%s → refused before anything is read", async (_n, extra) => {
    const { admin, calls } = fakeAdmin();
    expect(await run(admin, { ...readyFacts(), ...extra })).toEqual({ result: "facts_refused", code: "secret_in_facts" });
    expect(calls).toEqual([]);
  });

  it("the wrong facts version, or not an object, is refused", async () => {
    expect((await run(fakeAdmin().admin, { ...readyFacts(), factsVersion: 2 })).code).toBe("wrong_facts_version");
    expect((await run(fakeAdmin().admin, [])).code).toBe("not_an_object");
  });

  // ops01: E.164 To, an MG SID, a time not in the future, a status in the
  // closed set; anything malformed leaves the checklist item UNKNOWN.
  it.each<[string, Record<string, unknown>]>([
    ["To not E.164", { toNumber: "416-555-0100" }],
    ["To not canonical", { toNumber: "+1 4165550100" }],
    ["SID not MG", { messagingServiceSid: `PN${"c".repeat(32)}` }],
    ["SID too short", { messagingServiceSid: "MG123" }],
    ["time in the future", { observedAt: "2026-10-19T00:00:00Z" }],
    ["time unparseable", { observedAt: "yesterday" }],
    ["route status out of range", { routeStatus: 999 }],
    ["route status a string", { routeStatus: "200" }],
    ["reachedRoute a string", { reachedRoute: "true" }],
  ])("live STOP %s → reported malformed, stop_forwarded never passes, not ready", async (_n, bad) => {
    const facts = readyFacts();
    Object.assign(facts.liveStopObservation as Record<string, unknown>, bad);
    const r = await run(fakeAdmin().admin, facts);
    expect(r.malformed?.length).toBeGreaterThan(0);
    expect(r.checks?.find((c) => c.id === "stop_forwarded")?.status).not.toBe("pass");
    expect(r.ready).toBe(false);
  });

  // Codex P2 4305455242: Date.parse accepts locale forms and rolls invalid
  // dates over; every timestamp must be a strict ISO instant on a real date.
  it.each([
    ["a locale date", "10/12/2026"],
    ["a rolled-over date (Feb 30)", "2026-02-30T00:00:00Z"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["hour 24", "2026-10-12T24:00:00Z"],
    ["no zone", "2026-10-12T12:00:00"],
    ["a date only", "2026-10-12"],
    ["a non-ISO separator", "2026-10-12 12:00:00Z"],
    ["an offset out of range", "2026-10-12T12:00:00+25:00"],
  ])("a timestamp that is %s is malformed (never feeds a pass)", async (_n, bad) => {
    const facts = readyFacts();
    (facts.liveStopObservation as Record<string, unknown>).observedAt = bad;
    (facts.currentActivation as Record<string, unknown>).handlerDeployedAt = bad;
    const r = await run(fakeAdmin().admin, facts);
    expect(r.malformed).toEqual(expect.arrayContaining(["liveStopObservation.observedAt", "currentActivation.handlerDeployedAt"]));
    expect(r.checks?.find((c) => c.id === "stop_forwarded")?.status).not.toBe("pass");
    expect(r.ready).toBe(false);
  });

  it("strict ISO instants with Z, an offset, or fractional seconds are accepted", async () => {
    for (const ok of ["2026-10-12T12:00:00Z", "2026-10-12T12:00Z", "2026-10-12T17:30:00.123+05:30", "2024-02-29T00:00:00Z"]) {
      const facts = readyFacts();
      (facts.liveStopObservation as Record<string, unknown>).observedAt = ok;
      const r = await run(fakeAdmin().admin, facts);
      expect(r.malformed, ok).not.toContain("liveStopObservation.observedAt");
    }
  });

  it("a malformed Webhook Rule makes the whole rule set unread (webhook_rules unknown)", async () => {
    const r = await run(fakeAdmin().admin, { ...readyFacts(), webhookRules: { matched: true, settings: [{ percentage: 101 }] } });
    expect(r.malformed).toContain("webhookRules");
    expect(r.checks?.find((c) => c.id === "webhook_rules")?.status).toBe("unknown");
  });

  it("every top-level fact group malformed: nothing passes that depends on it, and the run is never ready", () => {
    const s = sanitizeFacts(
      {
        factsVersion: 1,
        deployment: "x",
        signatureProof: 1,
        endpointProbe: [],
        service: "x",
        webhookRules: 1,
        webhookPropagation: "x",
        staticProxyEnabled: "no",
        edgeZoneCatalog: {},
        liveStopObservation: "x",
        currentActivation: 1,
        optOutConfiguration: [],
      },
      NOW,
    );
    expect("refused" in s).toBe(false);
    if ("refused" in s) return;
    expect(s.malformed.length).toBeGreaterThanOrEqual(10);
  });
});

describe("output and reach", () => {
  it("the printed result carries codes and ids only: no phone number, SID, token or URL", async () => {
    const r = await run(fakeAdmin().admin, readyFacts(), "record");
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/\+1\d{10}/);
    expect(text).not.toMatch(/\b(MG|AC|PN|AP)[0-9a-f]{32}\b/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/present/);
  });

  it("targets a local Supabase only, unless hosting is explicitly approved (flag AND env)", () => {
    expect(targetAllowed("http://127.0.0.1:61321", false, {})).toEqual({ ok: true, hosted: false });
    expect(targetAllowed("http://localhost:54321", false, {})).toEqual({ ok: true, hosted: false });
    expect(targetAllowed("https://abc.supabase.co", false, {})).toEqual({ ok: false, code: "hosted_not_approved" });
    expect(targetAllowed("https://abc.supabase.co", true, {})).toEqual({ ok: false, code: "hosted_not_approved" });
    expect(targetAllowed("https://abc.supabase.co", false, { HONE_STOP_PREFLIGHT_HOSTED_APPROVED: "yes" })).toEqual({ ok: false, code: "hosted_not_approved" });
    expect(targetAllowed("https://abc.supabase.co", true, { HONE_STOP_PREFLIGHT_HOSTED_APPROVED: "yes" })).toEqual({ ok: true, hosted: true });
    expect(targetAllowed(undefined, true, {})).toEqual({ ok: false, code: "no_supabase_url" });
  });

  it("NO app code imports the script (scripts/ is operator-only)", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && /scripts\/sms|stop-preflight\/(run|facts)/.test(readFileSync(p, "utf8"))) {
          offenders.push(path.relative(root, p));
        }
      }
    };
    for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
    expect(offenders).toEqual([]);
  });

  // Codex P2 4305455246: the record step must reach the same target as the
  // dry run, and the hosted case must show both gates.
  it("the runbook exports the target once and shows the hosted gates on the record command", () => {
    const rb = readFileSync(path.join(process.cwd(), "docs/runbooks/sms-stop-preflight-record.md"), "utf8");
    expect(rb).toMatch(/export NEXT_PUBLIC_SUPABASE_URL=/);
    expect(rb).toMatch(/export SUPABASE_SERVICE_ROLE_KEY=/);
    expect(rb).toMatch(/export HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes/);
    expect(rb).toMatch(/--record --context cutover --allow-hosted/);
    expect(rb).not.toMatch(/^NEXT_PUBLIC_SUPABASE_URL=\S+ SUPABASE_SERVICE_ROLE_KEY=/m);
    // Codex P2 4305485849: the credentials are cleared only AFTER the last
    // record command, never between the dry run and the record step.
    const lastRecord = rb.lastIndexOf("--record --context cutover");
    const unset = rb.indexOf("unset HONE_STOP_PREFLIGHT_HOSTED_APPROVED");
    expect(lastRecord).toBeGreaterThan(-1);
    expect(unset).toBeGreaterThan(lastRecord);
    expect(rb.match(/unset HONE_STOP_PREFLIGHT_HOSTED_APPROVED/g)).toHaveLength(1);
    // Codex P2 4305512205: the script treats every non-loopback target as
    // hosted, so the runbook may not promise staging "any time" without gates.
    expect(rb).not.toMatch(/staging[^.\n]*any time/i);
    expect(rb).toMatch(/Any non-local target, staging included/);
  });

  it("the CLI defaults to DRY RUN and records only with an explicit --record", () => {
    const cli = readFileSync(path.join(process.cwd(), "scripts/sms/record-stop-preflight.mjs"), "utf8");
    expect(cli).toMatch(/record: false/);
    expect(cli).toMatch(/mode: args\.record \? "record" : "dry_run"/);
  });
});


// Execute only the CLI's early refusals, with no inherited credentials,
// approval flags or Node hooks. Even the loopback case has no service key,
// so no case can import/construct a Supabase client or make a request.
describe("CLI startup and early refusal without a target connection", () => {
  it.each([
    {
      label: "missing arguments",
      args: [] as string[],
      env: {},
      expected: { result: "invalid_arguments", code: "missing_argument" },
    },
    {
      label: "no target URL",
      args: ["--studio", STUDIO, "--facts", "never-read-facts.json"],
      env: {},
      expected: { result: "target_refused", code: "no_supabase_url" },
    },
    {
      label: "hosted record flag without hosted approval",
      args: ["--studio", STUDIO, "--facts", "never-read-facts.json", "--record", "--allow-hosted"],
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" },
      expected: { result: "target_refused", code: "hosted_not_approved" },
    },
    ...["ftp://localhost", "httpss://localhost", "ftp://example.invalid"].map((url) => ({
      label: `unsupported target scheme ${url}`,
      args: ["--studio", STUDIO, "--facts", "never-read-facts.json", "--allow-hosted"],
      env: { NEXT_PUBLIC_SUPABASE_URL: url, HONE_STOP_PREFLIGHT_HOSTED_APPROVED: "yes" },
      expected: { result: "target_refused", code: "unparseable_supabase_url" },
    })),
    {
      label: "loopback target without service key",
      args: ["--studio", STUDIO, "--facts", "never-read-facts.json", "--record"],
      env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1" },
      expected: { result: "target_refused", code: "no_service_role_key" },
    },
  ])("$label exits with one JSON refusal before facts/client access", ({ args, env, expected }) => {
    const child = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts/sms/record-stop-preflight.mjs"), ...args],
      { cwd: process.cwd(), env: { NODE_ENV: "test", ...env }, encoding: "utf8", timeout: 10_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(2);
    expect(child.stderr).toBe("");
    expect(child.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toEqual(expected);
  });
});
