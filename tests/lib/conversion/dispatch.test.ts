import { describe, expect, it, vi } from "vitest";

const alerts: Record<string, unknown>[] = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: Record<string, unknown>) => {
    alerts.push(a);
  },
}));

const { dispatchBookingConversion } = await import("@/lib/conversion/dispatch");
import type { ConversionProviderAdapter } from "@/lib/conversion/types";
import type { DecryptResult } from "@/lib/conversion/token-crypto";

type MockState = {
  rows: unknown[];
  claimWins: boolean[];
  updates: { table: string; patch: Record<string, unknown> }[];
  rpc: { name: string; args: unknown }[];
};
function mkState(rows: unknown[], claimWins: boolean[]): MockState {
  return { rows, claimWins, updates: [], rpc: [] };
}

// Mock admin: from().select().eq().eq() → { data: rows }; from().update().eq()×3
// → { error:null }; rpc() → { data: claimWin }.
function makeAdmin(state: MockState) {
  return {
    from(table: string) {
      let isUpdate = false;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          isUpdate = true;
          state.updates.push({ table, patch: p });
          return chain;
        },
        eq: () => chain,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(isUpdate ? { error: null } : { data: state.rows }).then(f, r),
      };
      return chain;
    },
    rpc: (name: string, args: unknown) => {
      state.rpc.push({ name, args });
      const won = state.claimWins.length ? state.claimWins.shift()! : true;
      return Promise.resolve({ data: won, error: null });
    },
  } as never;
}

function fakeAdapter(over: Partial<ConversionProviderAdapter> = {}) {
  const sent: unknown[] = [];
  const a: ConversionProviderAdapter & { sent: unknown[] } = {
    provider: "meta",
    sent,
    buildPayload: (e) => ({ provider: "meta", eventId: e.eventId, body: { data: [] } }),
    send: async (p) => {
      sent.push(p);
      return { ok: true, providerEventId: null };
    },
    ...over,
  } as ConversionProviderAdapter & { sent: unknown[] };
  return a;
}

const okDecrypt = (): DecryptResult => ({ ok: true, token: "DECRYPTED" });
const enabledRow = {
  provider: "meta",
  enabled: true,
  browser_tag_id: "PX",
  encrypted_server_token: "iv:tag:ct",
  conversion_action_id: null,
  test_event_code: null,
  consent_mode: "explicit",
};

function params(over: Record<string, unknown> = {}) {
  return {
    studioId: "studio_A",
    appointmentId: "appt_1",
    eventTimeUnixSeconds: 1_780_000_000,
    consentGranted: true,
    email: "jane@example.com",
    phone: "4165551234",
    serviceModality: "electrolysis",
    eventSourceUrl: "https://hone.care/book/willow",
    ...over,
  };
}

describe("dispatchBookingConversion: gates", () => {
  it("consent false → sends nothing, no DB query", async () => {
    const a = fakeAdapter();
    const state = mkState([enabledRow], []);
    await dispatchBookingConversion(params({ consentGranted: false }), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: okDecrypt,
    });
    expect(a.sent).toHaveLength(0);
    expect(state.rpc).toHaveLength(0);
  });

  it("no enabled provider config → sends nothing", async () => {
    const a = fakeAdapter();
    const state = mkState([], []);
    await dispatchBookingConversion(params(), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: okDecrypt,
    });
    expect(a.sent).toHaveLength(0);
  });

  it("token decrypt fails → skip (no send), records skipped", async () => {
    const a = fakeAdapter();
    const state = mkState([enabledRow], [true]);
    await dispatchBookingConversion(params(), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: () => ({ ok: false, reason: "decrypt_failed" }),
    });
    expect(a.sent).toHaveLength(0);
    expect(state.updates[0].patch.status).toBe("skipped");
    expect(String(state.updates[0].patch.skipped_reason)).toContain("decrypt_failed");
  });

  it("enabled + consent + decrypt ok + claim won → sends exactly one, records sent", async () => {
    const a = fakeAdapter();
    const state = mkState([enabledRow], [true]);
    await dispatchBookingConversion(params(), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: okDecrypt,
    });
    expect(a.sent).toHaveLength(1);
    expect(state.rpc[0].name).toBe("claim_conversion_delivery");
    expect(state.updates.at(-1)!.patch.status).toBe("sent");
  });

  it("dedup: claim lost (already delivered) → sends nothing", async () => {
    const a = fakeAdapter();
    const state = mkState([enabledRow], [false]);
    await dispatchBookingConversion(params(), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: okDecrypt,
    });
    expect(a.sent).toHaveLength(0);
  });

  it("provider send failure → records failed + a WARNING ops alert (booking not failed)", async () => {
    alerts.length = 0;
    const a = fakeAdapter({
      send: async () => ({ ok: false, retryable: true, errorSafe: "meta_http_500" }),
    });
    const state = mkState([enabledRow], [true]);
    // Must resolve (never throw) even though the provider "failed".
    await expect(
      dispatchBookingConversion(params(), {
        admin: makeAdmin(state),
        adapters: { meta: a },
        decrypt: okDecrypt,
      }),
    ).resolves.toBeUndefined();
    expect(state.updates.at(-1)!.patch.status).toBe("failed");
    expect(alerts[0].severity).toBe("warning");
  });

  it("never writes a raw token / email / phone into delivery status rows", async () => {
    const a = fakeAdapter();
    const state = mkState([enabledRow], [true]);
    await dispatchBookingConversion(params(), {
      admin: makeAdmin(state),
      adapters: { meta: a },
      decrypt: okDecrypt,
    });
    const json = JSON.stringify(state.updates);
    expect(json).not.toContain("DECRYPTED");
    expect(json).not.toContain("jane@example.com");
    expect(json).not.toContain("4165551234");
  });
});

