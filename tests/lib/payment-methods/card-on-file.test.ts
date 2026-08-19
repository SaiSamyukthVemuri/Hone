import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getCardOnFileStatuses,
  resolveCardOnFileStatus,
  shouldOfferPortalLink,
} from "@/lib/payment-methods/card-on-file";

// The Dashboard's card-on-file batch loader.
//
// The mock below FILTERS the scripted rows the way PostgREST would, so every
// predicate under test (studio_id, client_id set, stripe_livemode, status) is
// load-bearing: delete one from the loader and a test here goes red rather than
// passing on rows that were never filtered.

const h = vi.hoisted(() => ({
  livemode: false,
  rows: [] as Array<Record<string, unknown>>,
  error: null as unknown,
  calls: [] as Array<{ table: string; selected: string }>,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, readonly unknown[]]> = [];
      const q: Record<string, unknown> = {};
      q.select = (selected: string) => {
        h.calls.push({ table, selected });
        return q;
      };
      q.eq = (col: string, val: unknown) => {
        eqs.push([col, val]);
        return q;
      };
      q.in = (col: string, vals: readonly unknown[]) => {
        ins.push([col, vals]);
        return q;
      };
      q.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        if (h.error) return resolve({ data: null, error: h.error });
        return resolve({
          data: h.rows.filter(
            (r) =>
              eqs.every(([c, v]) => r[c] === v) &&
              ins.every(([c, vs]) => vs.includes(r[c])),
          ),
          error: null,
        });
      };
      return q;
    },
  }),
}));

const STUDIO = "studio-1";
const OTHER_STUDIO = "studio-2";
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

type Card = {
  client_id: string;
  studio_id?: string;
  stripe_livemode?: boolean;
  status?: string;
};

function scenario(cards: ReadonlyArray<Card>, deploymentLivemode = false) {
  h.livemode = deploymentLivemode;
  h.error = null;
  h.calls = [];
  h.rows = cards.map((c) => ({
    client_id: c.client_id,
    studio_id: c.studio_id ?? STUDIO,
    stripe_livemode: c.stripe_livemode ?? false,
    status: c.status ?? "active",
  }));
}

async function statusFor(clientId: string, clientIds = [CLIENT_A, CLIENT_B]) {
  const load = await getCardOnFileStatuses(STUDIO, clientIds);
  return resolveCardOnFileStatus(load, clientId);
}

beforeEach(() => {
  scenario([]);
});

describe("CARD YES — a trusted active card in the CURRENT mode", () => {
  it("an active, current-mode, same-studio card reads card_on_file", async () => {
    scenario([{ client_id: CLIENT_A }]);
    expect(await statusFor(CLIENT_A)).toBe("card_on_file");
  });
});

describe("CARD NO — a SUCCESSFUL query with no active card", () => {
  it("no rows at all → no_card", async () => {
    scenario([]);
    expect(await statusFor(CLIENT_A)).toBe("no_card");
  });

  it("a client without a card is no_card even when another client has one", async () => {
    scenario([{ client_id: CLIENT_A }]);
    expect(await statusFor(CLIENT_B)).toBe("no_card");
  });

  it("a REMOVED card is not a card on file", async () => {
    scenario([{ client_id: CLIENT_A, status: "removed" }]);
    expect(await statusFor(CLIENT_A)).toBe("no_card");
  });
});

describe("WRONG STRIPE MODE must never read as a card on file", () => {
  it("a TEST card while the deployment runs LIVE does not count", async () => {
    scenario([{ client_id: CLIENT_A, stripe_livemode: false }], true);
    expect(await statusFor(CLIENT_A)).not.toBe("card_on_file");
    expect(await statusFor(CLIENT_A)).toBe("no_card");
  });

  it("a LIVE card while the deployment runs TEST does not count", async () => {
    scenario([{ client_id: CLIENT_A, stripe_livemode: true }], false);
    expect(await statusFor(CLIENT_A)).not.toBe("card_on_file");
    expect(await statusFor(CLIENT_A)).toBe("no_card");
  });

  it("the SAME client's current-mode card still counts alongside a stale-mode one", async () => {
    scenario(
      [
        { client_id: CLIENT_A, stripe_livemode: false },
        { client_id: CLIENT_A, stripe_livemode: true },
      ],
      true,
    );
    expect(await statusFor(CLIENT_A)).toBe("card_on_file");
  });
});

describe("CROSS-STUDIO — another studio's card is not this studio's fact", () => {
  it("a card belonging to a different studio never counts", async () => {
    scenario([{ client_id: CLIENT_A, studio_id: OTHER_STUDIO }]);
    expect(await statusFor(CLIENT_A)).toBe("no_card");
  });

  it("only the requested client ids are ever asked for", async () => {
    scenario([{ client_id: "client-not-today" }]);
    const load = await getCardOnFileStatuses(STUDIO, [CLIENT_A]);
    expect(load.ok && load.clientsWithActiveCard.size).toBe(0);
  });
});

describe("READ ERROR is UNAVAILABLE — it is never 'No card'", () => {
  it("a failed query yields unavailable for every client in the batch", async () => {
    scenario([{ client_id: CLIENT_A }]);
    h.error = { code: "42501", message: "permission denied" };
    const load = await getCardOnFileStatuses(STUDIO, [CLIENT_A, CLIENT_B]);
    expect(load.ok).toBe(false);
    for (const c of [CLIENT_A, CLIENT_B]) {
      const status = resolveCardOnFileStatus(load, c);
      expect(status).toBe("unavailable");
      expect(status).not.toBe("no_card");
    }
  });

  it("the failure is not silently swallowed into an empty answer", async () => {
    scenario([]);
    h.error = { code: "PGRST301", message: "JWT expired" };
    const load = await getCardOnFileStatuses(STUDIO, [CLIENT_A]);
    // A bare Set would make this indistinguishable from "nobody has a card".
    expect(load).toEqual({ ok: false });
  });
});

describe("ONE CLIENT / TWO APPOINTMENTS — no N+1", () => {
  it("duplicate client ids collapse to ONE bounded query serving both rows", async () => {
    scenario([{ client_id: CLIENT_A }]);
    // The page passes today's client ids; a client with two appointments today
    // appears twice before de-duplication.
    const load = await getCardOnFileStatuses(STUDIO, [
      CLIENT_A,
      CLIENT_A,
      CLIENT_B,
    ]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].table).toBe("client_payment_methods");
    // Both of that client's rows read the SAME answer.
    expect(resolveCardOnFileStatus(load, CLIENT_A)).toBe("card_on_file");
    expect(resolveCardOnFileStatus(load, CLIENT_B)).toBe("no_card");
  });

  it("an empty day issues NO query at all", async () => {
    scenario([]);
    const load = await getCardOnFileStatuses(STUDIO, []);
    expect(h.calls).toHaveLength(0);
    expect(load).toEqual({ ok: true, clientsWithActiveCard: new Set() });
  });
});

describe("the loader reads a yes/no and nothing more", () => {
  // Comments stripped: the loader's own header deliberately NAMES the Stripe
  // columns it refuses to select, so a raw grep would trip on the explanation
  // rather than on the code.
  const SRC = readFileSync(
    path.join(process.cwd(), "lib/payment-methods/card-on-file.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("selects ONLY client_id — no Stripe identifier can reach the UI", async () => {
    scenario([{ client_id: CLIENT_A }]);
    await getCardOnFileStatuses(STUDIO, [CLIENT_A]);
    expect(h.calls[0].selected).toBe("client_id");
    for (const col of [
      "stripe_customer_id",
      "stripe_payment_method_id",
      "stripe_setup_intent_id",
      "stripe_account_id",
    ]) {
      expect(SRC).not.toContain(col);
    }
  });

  it("exactly one table, one .in(), and all four predicates", () => {
    expect((SRC.match(/from\("/g) ?? []).length).toBe(1);
    expect((SRC.match(/\.in\(/g) ?? []).length).toBe(1);
    expect(SRC).toMatch(/createAdminClient\(\)/);
    expect(SRC).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(SRC).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    expect(SRC).toMatch(/\.eq\("status", "active"\)/);
  });
});

describe("shouldOfferPortalLink — only a TRUSTED absence earns a nudge", () => {
  it("no_card offers it", () => {
    expect(shouldOfferPortalLink("no_card")).toBe(true);
  });
  it("card_on_file does NOT — the client already did it", () => {
    expect(shouldOfferPortalLink("card_on_file")).toBe(false);
  });
  it("unavailable does NOT — we do not know the card is missing", () => {
    expect(shouldOfferPortalLink("unavailable")).toBe(false);
  });
});
