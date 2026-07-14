import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requiredEventScopesForDestination,
  hasRequiredEventScopes,
  missingRequiredEventScopes,
  normalizeGrantedScopes,
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_DESTINATION_MODES,
} from "@/lib/google-calendar/destination-scopes";

const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

describe("requiredEventScopesForDestination — exact mapping + fail-closed", () => {
  it("dedicated -> app.created only", () => {
    expect(requiredEventScopesForDestination("dedicated_app_created")).toEqual([
      CALENDAR_APP_CREATED_SCOPE,
    ]);
  });
  it("existing_owned -> events.owned only", () => {
    expect(requiredEventScopesForDestination("existing_owned")).toEqual([
      CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });
  it("null/undefined/empty/unknown/case-variant -> null (never [])", () => {
    for (const bad of [null, undefined, "", "  ", "unknown", "existing", "dedicated", "EXISTING_OWNED"]) {
      expect(requiredEventScopesForDestination(bad as unknown as string)).toBeNull();
    }
  });
});

describe("hasRequiredEventScopes — exact set membership + prefix rejection + fail-closed", () => {
  it("existing_owned satisfied by exactly events.owned", () => {
    expect(hasRequiredEventScopes("existing_owned", [CALENDAR_EVENTS_OWNED_SCOPE])).toBe(true);
  });
  it("broad calendar.events does NOT satisfy existing_owned (prefix trap)", () => {
    expect(hasRequiredEventScopes("existing_owned", [EVENTS_BROAD])).toBe(false);
  });
  it("events.owned does NOT satisfy dedicated (wrong-mode grant)", () => {
    expect(hasRequiredEventScopes("dedicated_app_created", [CALENDAR_EVENTS_OWNED_SCOPE])).toBe(false);
  });
  it("app.created does NOT satisfy existing_owned (wrong-mode grant)", () => {
    expect(hasRequiredEventScopes("existing_owned", [CALENDAR_APP_CREATED_SCOPE])).toBe(false);
  });
  it("dedicated satisfied by exactly app.created", () => {
    expect(hasRequiredEventScopes("dedicated_app_created", [CALENDAR_APP_CREATED_SCOPE])).toBe(true);
  });
  it("a longer similar suffix does NOT satisfy owned", () => {
    expect(
      hasRequiredEventScopes("existing_owned", [CALENDAR_EVENTS_OWNED_SCOPE + ".extra"]),
    ).toBe(false);
  });
  it("null/unknown mode is fail-closed even with both event scopes present", () => {
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
  it("order independence + extra bundled scopes are fine (superset containment)", () => {
    expect(
      hasRequiredEventScopes("existing_owned", [
        "openid",
        CALENDAR_EVENTS_OWNED_SCOPE,
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe(true);
  });
  it("duplicate + whitespace-delimited provider grants normalize correctly", () => {
    expect(
      hasRequiredEventScopes("existing_owned", `${CALENDAR_EVENTS_OWNED_SCOPE} ${CALENDAR_EVENTS_OWNED_SCOPE}`),
    ).toBe(true);
  });
});

describe("normalizeGrantedScopes", () => {
  it("splits whitespace-delimited provider strings", () => {
    expect(normalizeGrantedScopes(`openid ${CALENDAR_EVENTS_OWNED_SCOPE}`)).toContain(
      CALENDAR_EVENTS_OWNED_SCOPE,
    );
  });
  it("dedupes + trims + drops empties", () => {
    expect(normalizeGrantedScopes([" openid ", "openid", "", "  "])).toEqual(["openid"]);
  });
  it("array and string produce equivalent membership", () => {
    expect(new Set(normalizeGrantedScopes("a b a"))).toEqual(new Set(["a", "b"]));
  });
  it("null/undefined -> []", () => {
    expect(normalizeGrantedScopes(null)).toEqual([]);
    expect(normalizeGrantedScopes(undefined)).toEqual([]);
  });
});

describe("missingRequiredEventScopes", () => {
  it("reports the missing exact scope for a partial (wrong) grant", () => {
    expect(missingRequiredEventScopes("existing_owned", [EVENTS_BROAD])).toEqual([
      CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });
  it("empty when the exact scope is present", () => {
    expect(missingRequiredEventScopes("dedicated_app_created", [CALENDAR_APP_CREATED_SCOPE])).toEqual([]);
  });
});

describe("app<->DB parity (generated contract — a one-sided change fails CI)", () => {
  const MIG = readFileSync(
    join(process.cwd(), "supabase/migrations/0131_google_calendar_dual_destination.sql"),
    "utf8",
  );
  it("both modes map to the same exact scopes in app helper and migration SQL", () => {
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
  it("broad calendar.events is NOT part of the destination contract", () => {
    expect(requiredEventScopesForDestination("existing_owned")).not.toContain(EVENTS_BROAD);
    expect(requiredEventScopesForDestination("dedicated_app_created")).not.toContain(EVENTS_BROAD);
  });
  it("the mode list matches the two allowed modes", () => {
    expect([...CALENDAR_DESTINATION_MODES].sort()).toEqual([
      "dedicated_app_created",
      "existing_owned",
    ]);
  });
});
