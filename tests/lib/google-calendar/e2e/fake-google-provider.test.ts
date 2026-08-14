import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGoogleFetch } from "@/lib/google-calendar/e2e/fake-google-provider";
import {
  readFakeGoogleEvents,
  resetFakeGoogleRun,
  setFakeGoogleScenario,
} from "@/lib/google-calendar/e2e/fake-google-ledger";
import {
  GOOGLE_CALENDAR_LIST_ENDPOINT,
  GOOGLE_CALENDARS_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_TOKENINFO_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
} from "@/lib/google-calendar/config";

// Focused unit tests for the guarded fake Google provider. We enable the fake
// markers on process.env for the duration of the test (a valid, unique run id +
// no deployed signal), exercise the real fakeGoogleFetch + ledger, then restore.

const RUN_ID = "run-providertest01";
const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";
const DISCOVERY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.flag = process.env.HONE_E2E_FAKE_GOOGLE;
  saved.rid = process.env.HONE_E2E_RUN_ID;
  process.env.HONE_E2E_FAKE_GOOGLE = "1";
  process.env.HONE_E2E_RUN_ID = RUN_ID;
  resetFakeGoogleRun(RUN_ID);
});
afterEach(() => {
  resetFakeGoogleRun(RUN_ID);
  process.env.HONE_E2E_FAKE_GOOGLE = saved.flag;
  process.env.HONE_E2E_RUN_ID = saved.rid;
});

async function postForm(url: string, body: string) {
  return fakeGoogleFetch(url, { method: "POST", body });
}
async function postJson(url: string, obj: unknown) {
  return fakeGoogleFetch(url, { method: "POST", body: JSON.stringify(obj) });
}

describe("fakeGoogleFetch: token / tokeninfo / userinfo", () => {
  it("code exchange returns the scenario's granted scopes + a refresh token", async () => {
    setFakeGoogleScenario(RUN_ID, { grantedScopes: [DISCOVERY, OWNED] });
    const r = await postForm(GOOGLE_TOKEN_ENDPOINT, "grant_type=authorization_code&code=x");
    const body = await r.json();
    expect(body.access_token).toContain("fake-access");
    expect(body.refresh_token).toContain("fake-refresh");
    expect(body.scope).toBe(`${DISCOVERY} ${OWNED}`);
  });
  it("refresh grant returns an access token but no refresh token", async () => {
    const r = await postForm(GOOGLE_TOKEN_ENDPOINT, "grant_type=refresh_token&refresh_token=x");
    const body = await r.json();
    expect(body.access_token).toContain("fake-access");
    expect(body.refresh_token).toBeUndefined();
  });
  it("tokeninfo echoes the granted scopes; userinfo returns the scenario identity", async () => {
    setFakeGoogleScenario(RUN_ID, { grantedScopes: [DISCOVERY, APP_CREATED], userSub: "sub-9", userEmail: "a@b.co" });
    expect((await (await fakeGoogleFetch(`${GOOGLE_TOKENINFO_ENDPOINT}?access_token=x`)).json()).scope)
      .toBe(`${DISCOVERY} ${APP_CREATED}`);
    const info = await (await fakeGoogleFetch(GOOGLE_USERINFO_ENDPOINT)).json();
    expect(info).toEqual({ sub: "sub-9", email: "a@b.co" });
  });
});

describe("fakeGoogleFetch: calendarList + calendars.insert scenarios", () => {
  it("calendarList returns the configured calendars (with roles)", async () => {
    setFakeGoogleScenario(RUN_ID, {
      calendarList: [
        { id: "own1", summary: "Mine", accessRole: "owner" },
        { id: "wr1", summary: "Shared", accessRole: "writer" },
      ],
    });
    const items = (await (await fakeGoogleFetch(`${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=writer`)).json()).items;
    expect(items.map((c: { id: string }) => c.id)).toEqual(["own1", "wr1"]);
  });

  it("normal provisioning: insert creates exactly one calendar, then reconciliation finds it", async () => {
    setFakeGoogleScenario(RUN_ID, { provisioning: "normal" });
    const desc = "hone-provisioning-attempt:TOKENAAA1234567";
    const created = await postJson(GOOGLE_CALENDARS_ENDPOINT, { summary: "Hone Appointments", description: desc });
    expect(created.status).toBe(200);
    expect((await created.json()).id).toContain("fake-cal");
    const list = (await (await fakeGoogleFetch(`${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=owner`)).json()).items;
    const matches = list.filter((c: { description?: string }) => c.description?.includes("TOKENAAA1234567"));
    expect(matches).toHaveLength(1);
  });

  it("ambiguous_multi: insert records TWO calendars for the same token (fail-closed reconcile)", async () => {
    setFakeGoogleScenario(RUN_ID, { provisioning: "ambiguous_multi" });
    const desc = "hone-provisioning-attempt:TOKENBBB1234567";
    await postJson(GOOGLE_CALENDARS_ENDPOINT, { summary: "Hone Appointments", description: desc });
    const list = (await (await fakeGoogleFetch(`${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=owner`)).json()).items;
    const matches = list.filter((c: { description?: string }) => c.description?.includes("TOKENBBB1234567"));
    expect(matches).toHaveLength(2);
  });

  it("insert_error_orphan: insert returns 500 but the orphan is reconcilable next time", async () => {
    setFakeGoogleScenario(RUN_ID, { provisioning: "insert_error_orphan" });
    const desc = "hone-provisioning-attempt:TOKENCCC1234567";
    const r = await postJson(GOOGLE_CALENDARS_ENDPOINT, { summary: "Hone Appointments", description: desc });
    expect(r.status).toBe(500);
    const list = (await (await fakeGoogleFetch(`${GOOGLE_CALENDAR_LIST_ENDPOINT}?minAccessRole=owner`)).json()).items;
    expect(list.filter((c: { description?: string }) => c.description?.includes("TOKENCCC1234567"))).toHaveLength(1);
  });

  it("records authorize/token/insert events for test assertions", async () => {
    await postForm(GOOGLE_TOKEN_ENDPOINT, "grant_type=authorization_code&code=x");
    await postJson(GOOGLE_CALENDARS_ENDPOINT, { summary: "Hone Appointments", description: "hone-provisioning-attempt:TOKZ1234567890" });
    const events = readFakeGoogleEvents(RUN_ID);
    expect(events.some((e) => e.type === "token_exchange")).toBe(true);
    expect(events.some((e) => e.type === "calendar_created")).toBe(true);
  });
});
