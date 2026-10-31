import { describe, it, expect } from "vitest";
import { createRefreshAttribution, isUnannouncedFind } from "@/lib/calendar/schedule-signal";

// Codex P2 on #1275: an interval or focus refresh that landed with an UNCHANGED fingerprint
// left its cause set, so a later toolbar navigation (a different week, a different fingerprint)
// was blamed on that fallback and burned the once-per-page degraded report.
const degraded = (a: ReturnType<typeof createRefreshAttribution>, changed: boolean) => {
  const last = a.landed(changed);
  return !!last && isUnannouncedFind({ cause: last.cause, announced: last.announced, fingerprintChanged: true });
};

describe("refresh attribution", () => {
  it("blames a fallback refresh that brought a change in", () => {
    const a = createRefreshAttribution();
    a.scoped("week|A");
    a.begin("interval", false);
    expect(degraded(a, true)).toBe(true);
  });

  it("does not blame a signal-announced refresh", () => {
    const a = createRefreshAttribution();
    a.begin("signal", true);
    expect(degraded(a, true)).toBe(false);
  });

  it("a refresh that landed unchanged is spent: a later navigation is not attributed to it", () => {
    const a = createRefreshAttribution();
    a.scoped("week|A");
    a.begin("interval", false);
    a.landed(false); // the refresh finished, fingerprint unchanged
    a.scoped("week|B"); // toolbar navigation
    expect(degraded(a, true)).toBe(false);
  });

  it("a navigation alone discards a pending fallback even if no landing was observed", () => {
    const a = createRefreshAttribution();
    a.scoped("week|A");
    a.begin("focus", false);
    a.scoped("week|B");
    expect(degraded(a, true)).toBe(false);
  });

  it("re-rendering the same range keeps the attribution", () => {
    const a = createRefreshAttribution();
    a.scoped("week|A");
    a.begin("interval", false);
    a.scoped("week|A");
    expect(degraded(a, true)).toBe(true);
  });

  it("attribution is consumed once", () => {
    const a = createRefreshAttribution();
    a.begin("interval", false);
    expect(degraded(a, true)).toBe(true);
    expect(degraded(a, true)).toBe(false);
  });
});
