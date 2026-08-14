import { afterEach, describe, expect, it, vi } from "vitest";

// Google Calendar: Phase B2.3-c2 correction: the production ConnectionStore's
// loadRefreshCiphertext must DISTINGUISH a genuinely-absent secret (null) from a
// FAILED/uncertain read (throw RefreshSecretReadError), so the token manager never
// mistakes a transient DB error for a missing token. No raw error is surfaced.

const h = vi.hoisted(() => ({
  maybeSingle: async (): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    // A minimal chainable stub: from/select/eq return the chain; maybeSingle is
    // driven by the hoisted handle so each test controls the read outcome.
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => h.maybeSingle();
    return chain;
  },
}));

import { createAdminConnectionStore } from "@/lib/google-calendar/sync/connection-store";
import { RefreshSecretReadError } from "@/lib/google-calendar/sync/token-manager";

afterEach(() => {
  h.maybeSingle = async () => ({ data: null, error: null });
});

describe("createAdminConnectionStore().loadRefreshCiphertext", () => {
  it("returns the ciphertext when the query succeeds with a secret row", async () => {
    h.maybeSingle = async () => ({ data: { encrypted_refresh_token: "v1:1:iv:tag:ct" }, error: null });
    const store = createAdminConnectionStore();
    await expect(store.loadRefreshCiphertext("conn-1", "studio-1")).resolves.toBe("v1:1:iv:tag:ct");
  });

  it("returns null when the query SUCCEEDS with no secret row (genuinely absent)", async () => {
    h.maybeSingle = async () => ({ data: null, error: null });
    const store = createAdminConnectionStore();
    await expect(store.loadRefreshCiphertext("conn-1", "studio-1")).resolves.toBeNull();
  });

  it("throws RefreshSecretReadError on a returned query error (never null); no raw detail leaks", async () => {
    h.maybeSingle = async () => ({ data: null, error: { message: "connection reset by peer", code: "PGRST500" } });
    const store = createAdminConnectionStore();
    await expect(store.loadRefreshCiphertext("conn-1", "studio-1")).rejects.toBeInstanceOf(RefreshSecretReadError);
    try {
      await store.loadRefreshCiphertext("conn-1", "studio-1");
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).not.toMatch(/connection reset by peer/);
      expect(msg).not.toMatch(/PGRST500/);
      expect(msg).not.toMatch(/conn-1/);
    }
  });

  it("throws RefreshSecretReadError when the query itself throws (transport error)", async () => {
    h.maybeSingle = async () => {
      throw new Error("socket hang up");
    };
    const store = createAdminConnectionStore();
    await expect(store.loadRefreshCiphertext("conn-1", "studio-1")).rejects.toBeInstanceOf(RefreshSecretReadError);
    try {
      await store.loadRefreshCiphertext("conn-1", "studio-1");
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/socket hang up/);
    }
  });
});
