import {
  cleanupFakeGoogleFiles,
  readFakeGoogleEvents,
  resetFakeGoogleRun,
  setFakeGoogleScenario,
  type FakeGoogleEvent,
  type FakeGoogleScenario,
} from "../../lib/google-calendar/e2e/fake-google-ledger";
import { GOOGLE_E2E_RUN_ID } from "./google-env";

// Playwright-runner side of the guarded fake-Google ledger. The runner is a
// SEPARATE process from the Next server; both coordinate through the run-id-keyed
// temp files (guarded, fail-closed). Test-only; never imported by app code.

const DISCOVERY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const APP_CREATED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const EVENTS_OWNED_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

export function configureFakeGoogle(scenario: Partial<FakeGoogleScenario>): void {
  setFakeGoogleScenario(GOOGLE_E2E_RUN_ID, scenario);
}
export function resetFakeGoogle(): void {
  resetFakeGoogleRun(GOOGLE_E2E_RUN_ID);
}
export function cleanupFakeGoogle(): void {
  cleanupFakeGoogleFiles(GOOGLE_E2E_RUN_ID);
}
export function fakeGoogleEvents(): FakeGoogleEvent[] {
  return readFakeGoogleEvents(GOOGLE_E2E_RUN_ID);
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
export { DISCOVERY as DISCOVERY_SCOPE };
