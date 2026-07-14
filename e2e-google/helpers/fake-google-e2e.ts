import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOGLE_E2E_RUN_ID } from "./google-env";

// Playwright-runner side of the guarded cross-process fake-Google ledger. The
// Next.js server writes/reads it through the SERVER-ONLY guarded module
// lib/google-calendar/e2e/fake-google-ledger.ts. The Playwright runner is a
// SEPARATE process and CANNOT import that module (`import "server-only"` throws at
// spec-compile time). So — exactly like e2e-payment/helpers/fake-stripe-ledger-
// e2e.ts — this helper reads/writes the SAME run-scoped temp files directly; the
// file format is the cross-process contract. Test-only; synthetic data only.

const PREFIX = "hone-e2e-google-";

export const APP_CREATED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const EVENTS_OWNED_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
export const DISCOVERY_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

// Kept in sync with lib/google-calendar/e2e/fake-google-ledger.ts by the file format.
export type FakeGoogleEvent =
  | { type: "authorize"; scopes: string[] }
  | { type: "token_exchange"; grantType: string }
  | { type: "calendar_created"; id: string; description: string }
  | { type: "calendar_insert_attempt"; result: "ok" | "error" };

export type FakeGoogleScenario = {
  grantedScopes: string[];
  userSub: string;
  userEmail: string;
  calendarList: Array<{ id: string; summary: string; accessRole: string; description?: string }>;
  provisioning: "normal" | "insert_error_orphan" | "ambiguous_multi";
};

const DEFAULT_SCENARIO: FakeGoogleScenario = {
  grantedScopes: [DISCOVERY_SCOPE],
  userSub: "e2e-sub",
  userEmail: "e2e-google@example.com",
  calendarList: [],
  provisioning: "normal",
};

function assertValidRunId(runId: string): string {
  if (typeof runId !== "string" || !/^[a-z0-9][a-z0-9-]{7,63}$/i.test(runId)) {
    throw new Error(`fake-google-e2e: invalid run id (${JSON.stringify(runId)}).`);
  }
  return runId;
}

function scenarioPath(): string {
  return join(tmpdir(), `${PREFIX}${assertValidRunId(GOOGLE_E2E_RUN_ID)}.scenario.json`);
}
function eventsPath(): string {
  return join(tmpdir(), `${PREFIX}${assertValidRunId(GOOGLE_E2E_RUN_ID)}.events.jsonl`);
}

// The runner writes the scenario (atomically — write tmp then rename, so the
// server never reads a half-written file). The server merges DEFAULT_SCENARIO on
// read, but we write the full merged object for robustness.
export function configureFakeGoogle(scenario: Partial<FakeGoogleScenario>): void {
  const merged: FakeGoogleScenario = { ...DEFAULT_SCENARIO, ...scenario };
  const p = scenarioPath();
  const tmp = `${p}.e2e.tmp`;
  writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
  renameSync(tmp, p);
}

export function fakeGoogleEvents(): FakeGoogleEvent[] {
  const p = eventsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FakeGoogleEvent);
}

export function resetFakeGoogle(): void {
  for (const p of [scenarioPath(), eventsPath()]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
export function cleanupFakeGoogle(): void {
  resetFakeGoogle();
}

// The scope(s) requested at each (fake) authorize step — proves the ACTIVE OAuth
// request asked for ONLY the exact destination scope.
export function fakeAuthorizeScopeSets(): string[][] {
  return fakeGoogleEvents()
    .filter((e): e is Extract<FakeGoogleEvent, { type: "authorize" }> => e.type === "authorize")
    .map((e) => e.scopes);
}
export function fakeCreatedCalendarCount(): number {
  return fakeGoogleEvents().filter((e) => e.type === "calendar_created").length;
}
