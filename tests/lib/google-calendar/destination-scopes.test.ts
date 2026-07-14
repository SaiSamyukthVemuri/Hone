import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isCalendarDestinationMode,
  requiredEventScopesForDestination,
  requiredEventScopeFor,
  hasRequiredEventScopes,
  missingRequiredEventScopes,
  normalizeGrantedScopes,
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_DESTINATION_MODES,
} from "@/lib/google-calendar/destination-scopes";

// Phase B2.4 — the destination-aware event-scope contract. The ONE trap this
// whole module exists to avoid: broad `calendar.events` is a literal PREFIX of
// `calendar.events.owned`, so membership MUST be exact, normalized Set equality —
// never substring / prefix / startsWith / one-string includes. Unknown/unset
// modes fail closed (required scopes are NULL, never an empty array).
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";
const DISCOVERY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

describe("isCalendarDestinationMode — narrows to the two modes only", () => {
  it("accepts exactly the two destination modes", () => {
    expect(isCalendarDestinationMode("dedicated_app_created")).toBe(true);
    expect(isCalendarDestinationMode("existing_owned")).toBe(true);
  });
  it("rejects null/undefined/empty/unknown/case-variant/non-string", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "  ",
      "unknown",
      "existing",
      "dedicated",
      "EXISTING_OWNED",
      "existing_owned ",
      0,
      1,
      {},
      [],
    ]) {
      expect(isCalendarDestinationMode(bad)).toBe(false);
    }
  });
});

describe("requiredEventScopesForDestination — exact mapping + fail-closed NULL", () => {
  it("dedicated -> [app.created] only", () => {
    expect(requiredEventScopesForDestination("dedicated_app_created")).toEqual([
      CALENDAR_APP_CREATED_SCOPE,
    ]);
  });
  it("existing_owned -> [events.owned] only", () => {
    expect(requiredEventScopesForDestination("existing_owned")).toEqual([
      CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });
  it("null/undefined/empty/unknown/case-variant -> null (NEVER [] — mirrors the DB)", () => {
    for (const bad of [null, undefined, "", "  ", "unknown", "existing", "dedicated", "EXISTING_OWNED"]) {
      const r = requiredEventScopesForDestination(bad as unknown as string);
      expect(r).toBeNull();
      // The fail-closed sentinel is null, not an empty array (empty [] would make
      // `.every()` vacuously true and mis-report readiness).
      expect(r).not.toEqual([]);
    }
  });
  it("broad calendar.events is NOT part of either destination's required scopes", () => {
    expect(requiredEventScopesForDestination("existing_owned")).not.toContain(EVENTS_BROAD);
    expect(requiredEventScopesForDestination("dedicated_app_created")).not.toContain(EVENTS_BROAD);
  });
});

describe("requiredEventScopeFor — the SINGLE bound scope string, else null", () => {
  it("returns the one exact scope for each mode", () => {
    expect(requiredEventScopeFor("dedicated_app_created")).toBe(CALENDAR_APP_CREATED_SCOPE);
    expect(requiredEventScopeFor("existing_owned")).toBe(CALENDAR_EVENTS_OWNED_SCOPE);
  });
  it("returns null (not a string) for null/undefined/unknown", () => {
    for (const bad of [null, undefined, "", "unknown", "EXISTING_OWNED"]) {
      expect(requiredEventScopeFor(bad as unknown as string)).toBeNull();
    }
  });
});

describe("normalizeGrantedScopes — split/trim/dedupe/drop-empty, no prefix transforms", () => {
  it("splits a whitespace-delimited provider string", () => {
    expect(normalizeGrantedScopes(`openid ${CALENDAR_EVENTS_OWNED_SCOPE}`)).toEqual([
      "openid",
      CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });
  it("splits on arbitrary/multiple whitespace runs", () => {
    expect(normalizeGrantedScopes("a\tb  c\n d")).toEqual(["a", "b", "c", "d"]);
  });
  it("accepts an array form unchanged (minus empties)", () => {
    expect(normalizeGrantedScopes(["a", "b"])).toEqual(["a", "b"]);
  });
  it("dedupes + trims + drops empties", () => {
    expect(normalizeGrantedScopes([" openid ", "openid", "", "  "])).toEqual(["openid"]);
  });
  it("dedupes within a whitespace string", () => {
    expect(normalizeGrantedScopes("a a b a")).toEqual(["a", "b"]);
  });
  it("string and array produce equivalent membership (ordering aside)", () => {
    expect(new Set(normalizeGrantedScopes("a b a"))).toEqual(new Set(normalizeGrantedScopes(["a", "b"])));
  });
  it("does NOT transform scope substrings/prefixes (broad events stays broad)", () => {
    expect(normalizeGrantedScopes(EVENTS_BROAD)).toEqual([EVENTS_BROAD]);
    expect(normalizeGrantedScopes(EVENTS_BROAD)).not.toContain(CALENDAR_EVENTS_OWNED_SCOPE);
  });
  it("null/undefined -> []", () => {
    expect(normalizeGrantedScopes(null)).toEqual([]);
    expect(normalizeGrantedScopes(undefined)).toEqual([]);
  });
});

describe("hasRequiredEventScopes — EXACT set membership + prefix rejection + fail-closed", () => {
  it("exact app.created satisfies dedicated", () => {
    expect(hasRequiredEventScopes("dedicated_app_created", [CALENDAR_APP_CREATED_SCOPE])).toBe(true);
  });
  it("exact events.owned satisfies existing_owned", () => {
    expect(hasRequiredEventScopes("existing_owned", [CALENDAR_EVENTS_OWNED_SCOPE])).toBe(true);
  });
  it("broad calendar.events does NOT satisfy existing_owned (the critical PREFIX trap)", () => {
    expect(hasRequiredEventScopes("existing_owned", [EVENTS_BROAD])).toBe(false);
    // Even bundled with discovery, the broad prefix must not count.
    expect(hasRequiredEventScopes("existing_owned", [DISCOVERY, EVENTS_BROAD])).toBe(false);
  });
  it("calendar.events.owned does NOT satisfy dedicated (wrong-mode grant)", () => {
    expect(hasRequiredEventScopes("dedicated_app_created", [CALENDAR_EVENTS_OWNED_SCOPE])).toBe(false);
  });
  it("calendar.app.created does NOT satisfy existing_owned (wrong-mode grant)", () => {
    expect(hasRequiredEventScopes("existing_owned", [CALENDAR_APP_CREATED_SCOPE])).toBe(false);
  });
  it("a made-up longer suffix (events.owned.extra) does NOT satisfy events.owned", () => {
    expect(hasRequiredEventScopes("existing_owned", [`${CALENDAR_EVENTS_OWNED_SCOPE}.extra`])).toBe(false);
  });
  it("duplicate exact scopes still satisfy (normalization dedupes)", () => {
    expect(
      hasRequiredEventScopes("existing_owned", [CALENDAR_EVENTS_OWNED_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE]),
    ).toBe(true);
  });
  it("a whitespace-delimited provider string satisfies exactly like an array", () => {
    expect(
      hasRequiredEventScopes("existing_owned", `${DISCOVERY} ${CALENDAR_EVENTS_OWNED_SCOPE}`),
    ).toBe(true);
  });
  it("ordering is irrelevant + extra bundled scopes are fine (superset containment)", () => {
    expect(
      hasRequiredEventScopes("existing_owned", [
        "openid",
        CALENDAR_EVENTS_OWNED_SCOPE,
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe(true);
  });
  it("null/unknown mode is fail-closed even with BOTH event scopes present", () => {
    expect(
      hasRequiredEventScopes(null, [CALENDAR_EVENTS_OWNED_SCOPE, CALENDAR_APP_CREATED_SCOPE]),
    ).toBe(false);
    expect(hasRequiredEventScopes("unknown", [CALENDAR_EVENTS_OWNED_SCOPE])).toBe(false);
  });
  it("EMPTY granted scopes are fail-closed (empty-array containment trap)", () => {
    expect(hasRequiredEventScopes("existing_owned", [])).toBe(false);
    expect(hasRequiredEventScopes("existing_owned", "")).toBe(false);
    expect(hasRequiredEventScopes("existing_owned", null)).toBe(false);
  });
});

describe("missingRequiredEventScopes", () => {
  it("reports the missing exact scope for a partial (broad-prefix) grant", () => {
    expect(missingRequiredEventScopes("existing_owned", [EVENTS_BROAD])).toEqual([
      CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });
  it("empty when the exact scope is present", () => {
    expect(missingRequiredEventScopes("dedicated_app_created", [CALENDAR_APP_CREATED_SCOPE])).toEqual([]);
  });
  it("an invalid mode yields [] here (readiness fails closed via hasRequiredEventScopes)", () => {
    expect(missingRequiredEventScopes("unknown", [CALENDAR_EVENTS_OWNED_SCOPE])).toEqual([]);
  });
});

describe("app<->DB parity (generated contract — a one-sided change fails CI)", () => {
  const MIG = readFileSync(
    join(process.cwd(), "supabase/migrations/0131_google_calendar_dual_destination.sql"),
    "utf8",
  );
  it("both modes map to the same exact scopes in the app helper and migration SQL", () => {
    expect(MIG).toContain("when 'dedicated_app_created' then");
    expect(MIG).toContain(CALENDAR_APP_CREATED_SCOPE);
    expect(MIG).toContain("when 'existing_owned' then");
    expect(MIG).toContain(CALENDAR_EVENTS_OWNED_SCOPE);
    expect(requiredEventScopesForDestination("dedicated_app_created")).toEqual([CALENDAR_APP_CREATED_SCOPE]);
    expect(requiredEventScopesForDestination("existing_owned")).toEqual([CALENDAR_EVENTS_OWNED_SCOPE]);
  });
  it("the migration returns NULL for invalid modes (fail-closed, never an empty array)", () => {
    expect(MIG).toMatch(/else null::text\[\]/);
    expect(MIG).not.toMatch(/else\s+array\[\]::text\[\]/);
  });
  it("the mode list matches exactly the two allowed modes", () => {
    expect([...CALENDAR_DESTINATION_MODES].sort()).toEqual(["dedicated_app_created", "existing_owned"]);
  });
});
