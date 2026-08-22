import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeferredReadError,
  requireLoadedForTab,
} from "@/app/(app)/clients/[id]/deferred-reads";

// ===========================================================================
// The PERF2 deferred-read invariant.
//
// #612's neutral values make NOT LOADED and LOADED AND EMPTY identical by
// construction, so this assertion cannot look at values. It compares the tab
// being rendered against the gate that decided whether that tab's read ran.
// These tests pin both halves of that: it is silent when they agree, and it
// names the read when they do not.
//
// The BEHAVIOURAL proof that it fires on a real regression lives in
// tests/db/client-profile-tab-behaviour.db.test.ts, which renders the real
// page. This file pins the helper itself.
// ===========================================================================

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("requireLoadedForTab", () => {
  it("is silent when every read the tab renders was loaded", () => {
    expect(() =>
      requireLoadedForTab("personal", { personal: { personalNotes: true } }),
    ).not.toThrow();
  });

  it("throws naming the tab and the read when a gate stopped covering it", () => {
    expect(() =>
      requireLoadedForTab("personal", { personal: { personalNotes: false } }),
    ).toThrow(DeferredReadError);
    try {
      requireLoadedForTab("personal", { personal: { personalNotes: false } });
      expect.unreachable("the invariant must throw");
    } catch (err) {
      expect((err as Error).message).toContain('"personal"');
      expect((err as Error).message).toContain("personalNotes");
    }
  });

  it("reports EVERY deferred read, not only the first", () => {
    try {
      requireLoadedForTab("overview", {
        overview: { overviewOnlyReads: false, intake: true, portalMessages: false },
      });
      expect.unreachable("the invariant must throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("overviewOnlyReads");
      expect(message).toContain("portalMessages");
      // `intake` loaded, so naming it would send someone after the wrong read.
      expect(message).not.toContain("intake");
    }
  });

  it("checks only the active tab, so another tab's deferral is not an error", () => {
    expect(() =>
      requireLoadedForTab("personal", {
        personal: { personalNotes: true },
        treatment: { treatmentPlans: false },
      }),
    ).not.toThrow();
  });

  it("does not check a tab the contract says nothing about", () => {
    expect(() => requireLoadedForTab("health", { personal: { personalNotes: false } })).not.toThrow();
  });

  it("carries read names and the tab, and nothing else", () => {
    // Every caller passes read NAMES. Nothing in this module can reach a
    // client id, a client name, or a loaded value, and this pins that the
    // message is built from its arguments alone.
    try {
      requireLoadedForTab("messages", { messages: { portalMessageReplies: false } });
      expect.unreachable("the invariant must throw");
    } catch (err) {
      const message = (err as Error).message;
      const allowed = /^[A-Za-z0-9 ."',:;()/-]+$/;
      expect(allowed.test(message)).toBe(true);
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no uuid
    }
  });

  it("returns immediately in production, so no practitioner can ever see it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const production = await import("@/app/(app)/clients/[id]/deferred-reads");
    expect(() =>
      production.requireLoadedForTab("personal", { personal: { personalNotes: false } }),
    ).not.toThrow();
  });
});
