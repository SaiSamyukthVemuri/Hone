import "server-only";
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertE2eFakeGoogleAllowed, isValidE2eRunId } from "./fake-google-guard";

// Guarded, cross-process ledger for the fake Google provider. Mirrors the fake-
// Stripe ledger (lib/stripe/e2e-fake-ledger.ts): the Next.js server process serves
// synthetic Google responses; the Playwright runner is a SEPARATE process that
// configures the per-run scenario and reads recorded events through run-id-keyed
// temp files — WITHOUT any browser-readable endpoint.
//
// Every read/write is gated by the fake-Google activation guard (fail-closed,
// deployment-impossible). Paths are constructed ONLY from os.tmpdir() + the
// validated run id + a fixed prefix — never from user/browser input.
//
// Stored fields are SYNTHETIC ONLY: requested OAuth scopes, a synthetic account
// sub/email, synthetic calendar ids/summaries/roles, and a NON-SENSITIVE
// provisioning-attempt token echoed in a synthetic calendar description. Never a
// real token, refresh token, key, client value, or PHI.

const PREFIX = "hone-e2e-google-";

export type FakeGoogleProvisioning = "normal" | "insert_error_orphan" | "ambiguous_multi";

export type FakeGoogleScenario = {
  // Scopes the fake token exchange reports as GRANTED (the actual grant). Default
  // is the Phase-A discovery scope only.
  grantedScopes: string[];
  // The synthetic connected-account identity returned by userinfo.
  userSub: string;
  userEmail: string;
  // Calendars the fake calendarList returns (owned-selection + role filtering).
  calendarList: Array<{ id: string; summary: string; accessRole: string; description?: string }>;
  // How the fake calendars.insert behaves (idempotency / ambiguity scenarios).
  provisioning: FakeGoogleProvisioning;
};

export type FakeGoogleEvent =
  | { type: "authorize"; scopes: string[] }
  | { type: "token_exchange"; grantType: string }
  | { type: "calendar_created"; id: string; description: string }
  | { type: "calendar_insert_attempt"; result: "ok" | "error" };

const DEFAULT_SCENARIO: FakeGoogleScenario = {
  grantedScopes: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  userSub: "e2e-sub",
  userEmail: "e2e-google@example.com",
  calendarList: [],
  provisioning: "normal",
};

function assertAllowed(runId: string): void {
  assertE2eFakeGoogleAllowed(process.env);
  if (!isValidE2eRunId(runId)) throw new Error("Invalid E2E run id for ledger access.");
}

function scenarioPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${runId}.scenario.json`);
}
function eventsPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${runId}.events.jsonl`);
}

// ----- Test-runner API (Playwright process) --------------------------------------
export function setFakeGoogleScenario(runId: string, scenario: Partial<FakeGoogleScenario>): void {
  assertAllowed(runId);
  const merged: FakeGoogleScenario = { ...DEFAULT_SCENARIO, ...scenario };
  const p = scenarioPath(runId);
  const tmp = `${p}.${Math.abs(hashRun(runId))}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
  renameSync(tmp, p);
}

export function readFakeGoogleEvents(runId: string): FakeGoogleEvent[] {
  assertAllowed(runId);
  const p = eventsPath(runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FakeGoogleEvent);
}

export function resetFakeGoogleRun(runId: string): void {
  assertAllowed(runId);
  for (const p of [scenarioPath(runId), eventsPath(runId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

export function cleanupFakeGoogleFiles(runId: string): void {
  resetFakeGoogleRun(runId);
}

// ----- Server-side (fake provider) API -------------------------------------------
export function readFakeGoogleScenario(runId: string): FakeGoogleScenario {
  assertAllowed(runId);
  const p = scenarioPath(runId);
  if (!existsSync(p)) return { ...DEFAULT_SCENARIO };
  try {
    return { ...DEFAULT_SCENARIO, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<FakeGoogleScenario>) };
  } catch {
    return { ...DEFAULT_SCENARIO };
  }
}

export function appendFakeGoogleEvent(runId: string, event: FakeGoogleEvent): void {
  assertAllowed(runId);
  const line = JSON.stringify(event).slice(0, 4000) + "\n";
  appendFileSync(eventsPath(runId), line, { mode: 0o600 });
}

// Calendars the fake has "created" so far (from recorded events) — the fake
// calendarList returns these (with their descriptions) so provisioning
// reconciliation by exact attempt-token works across requests.
export function createdCalendars(runId: string): Array<{ id: string; description: string }> {
  try {
    assertAllowed(runId);
  } catch {
    return [];
  }
  return readFakeGoogleEvents(runId)
    .filter((e): e is Extract<FakeGoogleEvent, { type: "calendar_created" }> => e.type === "calendar_created")
    .map((e) => ({ id: e.id, description: e.description }));
}

// Deterministic tmp-suffix seed from the validated run id — no Math.random.
function hashRun(runId: string): number {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = (h * 31 + runId.charCodeAt(i)) | 0;
  return h;
}
