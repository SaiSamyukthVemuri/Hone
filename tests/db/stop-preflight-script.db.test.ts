import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import { runStopPreflight } from "@/scripts/sms/stop-preflight/run";
import { STOP_PREFLIGHT_CHECKLIST } from "@/lib/sms/inbound-stop-preflight";
import { decideStudioRoute } from "@/lib/sms/send-time-route";
import { parseLiveRegistrationState } from "@/lib/sms/sender-registration";

// HON-50 G6 operator script against a real database (isolated stack only):
// DRY RUN writes nothing; --record writes exactly the evaluator's v1 output
// through 0230 with the CAS read first; a stale CAS is refused; and the
// recorded preflight is what the send path's route decision accepts.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ORIGIN = "https://hone.care";
const BASE = "https://hone.care";
const hex = (n: number) => randomBytes(n).toString("hex");
const mg = () => `MG${hex(16)}`;
const ACCOUNT = `AC${"1".repeat(32)}`;
const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
let controls: typeof import("@/lib/sms/sender-controls");
let appAdmin: SupabaseClient;
let scriptAdmin: SupabaseClient;

async function freshNumber(): Promise<string> {
  for (;;) {
    const n = `+1416555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const { rows } = await adminQuery("select 1 from public.studio_sms_senders where phone_number = $1 or claimed_phone_number = $1 limit 1", [n]);
    if (rows.length === 0) return n;
  }
}

async function adopt(s: SeededStudio, number: string, service: string) {
  const provider = new FakeSmsProvisioningProvider({
    preOwnedNumbers: { [number]: `PN${hex(16)}` },
    accountServices: [{ sid: service, numbers: [number], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` }],
  });
  return controls.runSenderAdoption(
    { admin: appAdmin, provider, appOrigin: ORIGIN, testDestination: "+14165553199" },
    { studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: number, messagingServiceSid: service },
  );
}

/** A facts file that evaluates READY for `number` through `service`. */
const readyFacts = (number: string, service: string) => ({
  factsVersion: 1,
  deployment: { webhookBaseUrl: BASE, authTokenSet: true, appOrigin: BASE, accountSid: ACCOUNT },
  signatureProof: { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "2026-10-01T00:00:00Z" },
  endpointProbe: { status: 405, redirectedTo: null },
  service: {
    inboundRequestUrl: `${BASE}/api/twilio/inbound-sms#ct=1000&rt=5000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`,
    inboundMethod: "POST",
    useInboundWebhookOnNumber: false,
    numberSmsUrl: null,
    numberSmsApplicationSid: null,
    accountSid: ACCOUNT,
  },
  webhookRules: { matched: false },
  staticProxyEnabled: false,
  webhookPropagation: { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 3600 },
  liveStopObservation: { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true, observedAt: "2026-10-12T12:00:00Z", toNumber: number, messagingServiceSid: service },
  optOutConfiguration: { dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" },
  currentActivation: { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" },
});

const rows = async (studioId: string) =>
  (await adminQuery("select ready, checklist_version, checks, context from public.studio_sms_sender_stop_preflights where studio_id = $1", [studioId])).rows;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  controls = await import("@/lib/sms/sender-controls");
  appAdmin = (await import("@/lib/supabase/admin-server")).createAdminClient();
  // The script builds its own plain supabase-js service_role client.
  scriptAdmin = createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  await closePool();
});

describe("the operator script against a real database", () => {
  it("DRY RUN evaluates READY and writes nothing; --record then writes exactly the v1 checklist, and the route accepts it", async () => {
    const s = await seedStudio("sps-ready");
    const number = await freshNumber();
    const service = mg();
    expect(await adopt(s, number, service)).toMatchObject({ ok: true, result: "adopted" });

    const dry = await runStopPreflight({ admin: scriptAdmin, studioId: s.studioId, raw: readyFacts(number, service), mode: "dry_run", context: "cutover", nowMs: Date.now() });
    expect(dry).toMatchObject({ result: "evaluated", ready: true, malformed: [] });
    expect(await rows(s.studioId)).toEqual([]);

    const rec = await runStopPreflight({ admin: scriptAdmin, studioId: s.studioId, raw: readyFacts(number, service), mode: "record", context: "cutover", nowMs: Date.now() });
    expect(rec).toMatchObject({ result: "recorded", ready: true });
    const [row] = await rows(s.studioId);
    expect(row).toMatchObject({ ready: true, checklist_version: 1, context: "cutover" });
    expect((row.checks as Array<{ id: string; status: string }>).map((c) => c.id)).toEqual([...STOP_PREFLIGHT_CHECKLIST]);

    // The send path, from the real snapshot: past G6 (a CA recipient from a CA
    // long code is then decided by readiness, so the refusal is not G6's).
    const { data } = await scriptAdmin.rpc("get_live_studio_sms_sender_registration_state", { p_studio_id: s.studioId });
    const state = parseLiveRegistrationState(data, s.studioId);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const route = decideStudioRoute({
      studioId: s.studioId,
      recipientE164: "+14165550123",
      read: { ok: true, senders: state.senders as never, registrations: state.registrations, campaignBindings: state.campaignBindings, stopPreflights: state.stopPreflights },
      env: { TWILIO_WEBHOOK_BASE_URL: BASE },
    });
    expect((route as { reason?: string }).reason ?? "").not.toMatch(/^stop_preflight_/);
  });

  it("a run that read the record BEFORE another recording landed is refused (CAS), and the newer record stands", async () => {
    const s = await seedStudio("sps-cas");
    const number = await freshNumber();
    const service = mg();
    await adopt(s, number, service);
    // A not-ready record lands first...
    const notReady = { ...readyFacts(number, service), optOutConfiguration: { dropsKeywordMessages: true, lastChangedAt: "2026-10-01T00:00:00Z" } };
    expect((await runStopPreflight({ admin: scriptAdmin, studioId: s.studioId, raw: notReady, mode: "record", context: "evidence", nowMs: Date.now() })).result).toBe("recorded");
    // ...and a recording whose CAS token predates it is refused by the writer.
    const sender = (await adminQuery("select id, phone_number, messaging_service_sid from public.studio_sms_senders where studio_id = $1 and status = 'active'", [s.studioId])).rows[0];
    const stale = (await adminQuery("select * from public.record_studio_sms_stop_preflight($1, $2, $3, $4, $5::jsonb, 1::smallint, $6, null, null, 'cutover', null)", [
      s.studioId, sender.id, sender.phone_number, sender.messaging_service_sid,
      JSON.stringify(STOP_PREFLIGHT_CHECKLIST.map((id) => ({ id, status: "pass" }))), BASE,
    ])).rows[0];
    expect(stale).toEqual({ result: "preflight_changed", preflight_id: null });
    expect((await rows(s.studioId))[0]).toMatchObject({ ready: false });
  });

  it("a malformed live STOP is recorded NOT ready (stop_forwarded never passes)", async () => {
    const s = await seedStudio("sps-bad");
    const number = await freshNumber();
    const service = mg();
    await adopt(s, number, service);
    const bad = readyFacts(number, service);
    bad.liveStopObservation.toNumber = "416-555-0100";
    const r = await runStopPreflight({ admin: scriptAdmin, studioId: s.studioId, raw: bad, mode: "record", context: "evidence", nowMs: Date.now() });
    expect(r).toMatchObject({ result: "recorded", ready: false });
    expect(r.malformed).toContain("liveStopObservation.toNumber");
    expect((await rows(s.studioId))[0]).toMatchObject({ ready: false });
  });

  it("a facts file carrying a secret writes nothing", async () => {
    const s = await seedStudio("sps-secret");
    const number = await freshNumber();
    const service = mg();
    await adopt(s, number, service);
    const r = await runStopPreflight({
      admin: scriptAdmin,
      studioId: s.studioId,
      raw: { ...readyFacts(number, service), deployment: { webhookBaseUrl: BASE, TWILIO_AUTH_TOKEN: "abc" } },
      mode: "record",
      context: "evidence",
      nowMs: Date.now(),
    });
    expect(r).toEqual({ result: "facts_refused", code: "secret_in_facts" });
    expect(await rows(s.studioId)).toEqual([]);
  });
});
