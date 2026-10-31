import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const PAGE = read("app/(app)/settings/calendar/page.tsx");
const ACTIONS = read("app/(app)/settings/calendar/actions.ts");
const PICKER = read("app/(app)/settings/calendar/ColorPicker.tsx");
const FEED = read("app/(app)/settings/calendar/CalendarFeedCard.tsx");
const PROFILE = read("app/(app)/settings/profile/page.tsx");
const PROFILE_ACTIONS = read("app/(app)/settings/profile/actions.ts");

describe("nothing studio-wide lives on this page (Display preferences belong to the shell workstream)", () => {
  it("no studio write, no owner-only block, no default-view control", () => {
    for (const src of [PAGE, ACTIONS]) {
      expect(src).not.toMatch(/from\("studios"\)|time_format|birthday_reminder_color|default[_ ]view/i);
    }
    expect(PAGE).not.toMatch(/isOwner|data-testid="studio-wide/);
  });
  it("every role sees the colour and the feed", () => {
    expect(PAGE).toMatch(/<ColorPicker\b/);
    expect(PAGE).toMatch(/<CalendarFeedCard\b/);
  });
});

describe("colour: only my own, never blocked by duplicates", () => {
  it("both colour writes go through the governed own-row command with no practitioner id", () => {
    expect(ACTIONS).toMatch(/rpc\("update_own_practitioner_profile"/);
    expect(PROFILE_ACTIONS).toMatch(/rpc\(\s*"update_own_practitioner_profile"/);
    expect(ACTIONS).not.toMatch(/p_practitioner_id|\.from\("practitioners"\)\s*\.update/);
  });
  it("the suggestion is re-derived on the server and never overwrites a chosen colour", () => {
    expect(ACTIONS).toMatch(/export async function applySuggestedColourAction\(\)/);
    expect(ACTIONS).toMatch(/practitioner\.color !== "neutral"/);
    expect(ACTIONS).toMatch(/suggestDistinctColour\(holders, practitioner\.id\)/);
  });
  it("the page never writes while rendering, and duplicates are information only", () => {
    expect(PAGE).not.toMatch(/rpc\(|\.update\(|\.insert\(/);
    expect(PICKER).not.toMatch(/disabled=\{[^}]*taken/);
  });
});

describe("the feed and colour moved here from Profile, behaviour intact", () => {
  it("Profile no longer renders them and points to Calendar", () => {
    expect(PROFILE).not.toMatch(/<ColorPicker|<CalendarFeedCard/);
    expect(PROFILE).toMatch(/href="\/settings\/calendar"/);
  });
  it("Calendar renders both, for every role", () => {
    expect(PAGE).toMatch(/<ColorPicker\b/);
    expect(PAGE).toMatch(/<CalendarFeedCard\b/);
  });
  it("the feed card keeps its privacy warning and regeneration", () => {
    expect(FEED).toMatch(/rotateCalendarFeedTokenAction/);
    expect(FEED).toMatch(/clearCalendarFeedTokenAction/);
    expect(FEED).toMatch(/id="calendar-feed"/);
    expect(FEED).toMatch(/anyone with|private|secret/i);
  });
});
