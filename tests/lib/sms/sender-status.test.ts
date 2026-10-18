import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  OWNER_READABLE_SENDER_COLUMNS,
  RECOVERY_ROUTE_BY_ERROR_CODE,
  SENDER_STATUSES,
  presentSenderStatus,
  readOwnStudioSmsSender,
  type SenderRead,
  type SenderStatus,
  type StudioSmsSenderState,
} from "@/lib/sms/sender-status";
import { PROVIDER_ERROR_CODES } from "@/lib/sms/provider/types";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function row(over: Partial<StudioSmsSenderState> = {}): StudioSmsSenderState {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    studio_id: "22222222-2222-2222-2222-222222222222",
    provider: "twilio",
    status: "off",
    country: "US",
    requested_area_code: null,
    phone_number: null,
    provisioned_at: null,
    last_test_ok_at: null,
    last_error_code: null,
    last_error_at: null,
    released_at: null,
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

/** The database answered, and this is what it said. */
const ok = (sender: StudioSmsSenderState | null): SenderRead => ({
  ok: true,
  sender,
});

/** The database did not answer. */
const unavailable: SenderRead = { ok: false };

describe("the status vocabulary matches migration 0191, not a restatement", () => {
  const migration = read(
    "supabase/migrations/0191_studio_sms_sender_provisioning.sql",
  );

  it("covers exactly the eight statuses the CHECK constraint allows", () => {
    // Parsed out of the migration so a ninth status added there fails HERE
    // rather than rendering as a blank card in production.
    const check = migration.match(
      /studio_sms_senders_status_check[\s\S]*?check \(status in \(([\s\S]*?)\)\)/,
    );
    expect(check, "status CHECK not found in 0191").not.toBeNull();
    const fromSql = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(fromSql.length).toBeGreaterThan(0); // anti-vacuity
    expect([...fromSql].sort()).toEqual([...SENDER_STATUSES].sort());
  });

  it("reads exactly the columns 0191 grants to `authenticated`", () => {
    // The guarantee is that this surface cannot reach a provider identifier.
    // Asserting it against the GRANT rather than against a copied list means a
    // widened grant has to be noticed here too.
    const grant = migration.match(
      /grant select \(([\s\S]*?)\) on public\.studio_sms_senders to authenticated;/,
    );
    expect(grant, "column grant not found in 0191").not.toBeNull();
    const granted = grant![1]
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(granted.length).toBe(14); // anti-vacuity
    expect([...OWNER_READABLE_SENDER_COLUMNS].sort()).toEqual(
      [...granted].sort(),
    );
  });

  it("never names a provider identifier or the claim key", () => {
    for (const forbidden of [
      "messaging_service_sid",
      "phone_number_sid",
      "provisioning_claim_key",
      "provisioning_lease_generation",
      "claimed_phone_number",
    ]) {
      expect(
        OWNER_READABLE_SENDER_COLUMNS as readonly string[],
        `${forbidden} must not be readable by a browser session`,
      ).not.toContain(forbidden);
    }
  });
});

describe("every status presents, including the one production is actually in", () => {
  it("no row -> the honest empty state, which every studio is in today", () => {
    const view = presentSenderStatus(ok(null));
    expect(view.status).toBeNull();
    expect(view.tone).toBe("none");
    expect(view.headline).toBe("No sender configured");
    // It must say what DOES happen, or an operator reads this as "my texts are
    // not going out" — which would be false.
    expect(view.detail).toMatch(/shared sender/i);
    expect(view.phoneNumber).toBeNull();
    expect(view.recovery).toBe("none");
  });

  for (const status of SENDER_STATUSES) {
    it(`${status} renders a headline and a sentence`, () => {
      const view = presentSenderStatus(ok(row({ status })));
      expect(view.status).toBe(status);
      expect(view.headline.length).toBeGreaterThan(0);
      expect(view.detail.length).toBeGreaterThan(0);
    });
  }

  it("active reports the number and the passed test", () => {
    const view = presentSenderStatus(
      ok(
        row({
          status: "active",
          phone_number: "+15555550123",
          provisioned_at: "2026-09-20T00:00:00Z",
          last_test_ok_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(view.tone).toBe("live");
    expect(view.phoneNumber).toBe("+15555550123");
    expect(view.lastTestOkAt).toBe("2026-09-20T00:00:00Z");
    expect(view.recovery).toBe("none");
  });

  it("released is history and offers nothing", () => {
    // THE NUMBER IS EXPLICIT HERE ON PURPOSE. This assertion is about the
    // shape where a number really was owned and given up, and `row()` defaults
    // `phone_number` to null — so an earlier revision of this test built an
    // ABANDONED attempt and asserted the wording for a released purchase. The
    // null shape is a genuinely different sentence and is covered below.
    const view = presentSenderStatus(
      ok(
        row({
          status: "released",
          phone_number: "+15551230000",
          released_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(view.tone).toBe("retired");
    expect(view.recovery).toBe("none");
    expect(view.detail).toMatch(/never reused/i);
    // It is a CURRENT-state answer, not only a history note: an owner reading
    // "this number was given up" alone is left with the same "are my texts
    // going out?" question the empty state exists to answer.
    expect(view.detail).toMatch(/shared sender/i);
  });

  it("never offers a route 0191's transition guard forbids", () => {
    // `error` may retry or release; it may NEVER return to `off`. A surface
    // that offered "start over" would be asking for a transition the database
    // refuses — and the gesture abandons a possibly-purchased number.
    for (const status of SENDER_STATUSES) {
      const view = presentSenderStatus(ok(row({ status })));
      expect(view.recovery).not.toBe("reset");
    }
    const errored = presentSenderStatus(
      ok(
        row({
          status: "error",
          last_error_code: "provider_timeout",
          last_error_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(errored.recovery).toBe("retry");
    expect(errored.detail).not.toMatch(/start over|reset/i);
  });
});

describe("#677 stays load-bearing: provider_configuration_required is not a dead end", () => {
  // THE POINT OF THIS BLOCK. `adoption.ts` refuses with
  // `provider_configuration_required` when a real messaging service simply is
  // not wired the way Hone requires — which is what #677's configure path
  // repairs. But REFUSAL_TO_STORE_CODE collapses that refusal and five others
  // into ONE stored code, `provider_resource_mismatch`. The persisted state
  // therefore cannot distinguish "configurable" from "not yours at all".
  //
  // These assertions pin the consequence so the eventual adoption lane cannot
  // quietly ship a surface that dead-ends on it.
  const adoption = read("lib/sms/adoption.ts");

  it("the collapse this depends on is real, not assumed", () => {
    expect(adoption).toMatch(
      /provider_configuration_required:\s*"provider_resource_mismatch"/,
    );
    expect(adoption).toMatch(
      /number_not_owned_by_account:\s*"provider_resource_mismatch"/,
    );
  });

  it("the shared stored code routes to an operator decision, never to nothing", () => {
    // `none` would be the dead end. `retry` would be a lie in the
    // not-owned case. Neither is acceptable.
    expect(RECOVERY_ROUTE_BY_ERROR_CODE.provider_resource_mismatch).toBe(
      "operator_decision",
    );
    const view = presentSenderStatus(
      ok(
        row({
          status: "error",
          last_error_code: "provider_resource_mismatch",
          last_error_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(view.recovery).toBe("operator_decision");
    expect(view.recovery).not.toBe("none");
    // And it must not claim to know which of the six refusals happened.
    expect(view.detail).not.toMatch(/webhook|not owned|does not own/i);
  });

  it("routes every provider error code the orchestration can store", () => {
    // A new code added to PROVIDER_ERROR_CODES without a route here would
    // otherwise fall to the `support` default silently.
    for (const code of PROVIDER_ERROR_CODES) {
      expect(
        RECOVERY_ROUTE_BY_ERROR_CODE[code],
        `${code} has no recovery route`,
      ).toBeDefined();
    }
  });

  it("an UNKNOWN code falls to support, never to retry", () => {
    const view = presentSenderStatus(
      ok(
        row({
          status: "error",
          last_error_code: "something_new_from_a_later_slice",
          last_error_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(view.recovery).toBe("support");
  });
});

describe("the status type stays aligned with the DB status domain", () => {
  it("SenderStatus accepts only migration statuses", () => {
    // Compile-time in spirit, asserted at runtime so the list cannot drift
    // unnoticed if the type is widened.
    const statuses: SenderStatus[] = [...SENDER_STATUSES];
    expect(statuses).toHaveLength(8);
  });
});

describe("a route may not promise more than the orchestration allows (#749 review)", () => {
  // Each of these was routed to `retry` in the first revision. `provisioning.ts`
  // calls `failWith(code, retryable, mayOwn)`, and for BOTH of these the
  // retryable argument is literally `false` — so the card was offering an
  // attempt the engine had already declared pointless.
  const provisioning = read("lib/sms/provisioning.ts");

  it("the vanished number really is non-retryable in the engine", () => {
    expect(provisioning).toMatch(
      /failWith\("number_no_longer_available",\s*false,\s*false\)/,
    );
  });

  it("a vanished number routes to release, not retry", () => {
    // The claim's phone number is write-once, so this attempt can only ever ask
    // about the same gone number again. The exit is `releasing`.
    expect(RECOVERY_ROUTE_BY_ERROR_CODE.number_no_longer_available).toBe(
      "release_only",
    );
    const view = presentSenderStatus(
      ok(
        row({
          status: "error",
          last_error_code: "number_no_longer_available",
          last_error_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(view.recovery).toBe("release_only");
    expect(view.detail).not.toMatch(/attempted again/i);
  });

  it("the finalize CONFLICT really is non-retryable in the engine", () => {
    // `retryable = (finalized !== "conflict")`, so conflict is false and a
    // plain finalize failure is true. They are not the same answer.
    expect(provisioning).toMatch(
      /finalized === "conflict" \? "finalize_conflict" : "finalize_failed",\s*\n?\s*finalized !== "conflict",/,
    );
  });

  it("a finalize conflict needs looking at; a finalize failure may retry", () => {
    expect(RECOVERY_ROUTE_BY_ERROR_CODE.finalize_conflict).toBe("support");
    expect(RECOVERY_ROUTE_BY_ERROR_CODE.finalize_failed).toBe("retry");
    const conflict = presentSenderStatus(
      ok(
        row({
          status: "error",
          last_error_code: "finalize_conflict",
          last_error_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(conflict.recovery).toBe("support");
    expect(conflict.detail).not.toMatch(/attempted again/i);
  });
});

describe("a failed read is never reported as an absent sender (#749 review)", () => {
  // The defect this repository has already shipped once and fixed elsewhere:
  // `getAuditEventsByRecord` ignored its `error` and rendered "No history
  // recorded yet." over a read that had failed. The same shape here would
  // assert "No sender configured" — and "Messages are sent using Hone's shared
  // sender" — over an ACTIVE sender behind a transient failure.
  it("an unanswered read is its own state, not the empty state", () => {
    const view = presentSenderStatus(unavailable);
    expect(view.tone).toBe("unknown");
    expect(view.status).toBeNull();
    expect(view.headline).not.toBe("No sender configured");
    expect(view.headline).toMatch(/unavailable/i);
  });

  it("it claims NOTHING about whether a sender exists or how messages are sent", () => {
    const view = presentSenderStatus(unavailable);
    expect(view.detail).not.toMatch(/shared sender/i);
    expect(view.detail).not.toMatch(/no sender/i);
    expect(view.phoneNumber).toBeNull();
    expect(view.recovery).toBe("none");
  });

  it("an ANSWERED empty read still gets the honest empty state", () => {
    // Anti-vacuity for the pair: the fix must not collapse the other way and
    // make a genuine "no row" look like a failure.
    const view = presentSenderStatus(ok(null));
    expect(view.tone).toBe("none");
    expect(view.headline).toBe("No sender configured");
    expect(view.detail).toMatch(/shared sender/i);
  });

  it("the reader returns the two outcomes distinguishably", async () => {
    // Mirrors the real chain: .eq(...).order(...).limit(...).maybeSingle()
    const chainYielding = (result: unknown) => {
      const chain = {
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => result,
      };
      return { from: () => ({ select: () => ({ eq: () => chain }) }) } as never;
    };
    const failing = chainYielding({ data: null, error: { message: "boom" } });
    const answered = chainYielding({ data: null, error: null });

    expect(await readOwnStudioSmsSender(failing, "s")).toEqual({ ok: false });
    expect(await readOwnStudioSmsSender(answered, "s")).toEqual({
      ok: true,
      sender: null,
    });
  });
});

describe("a released sender is reachable, not filtered away (#749 review)", () => {
  // 0191 keeps released rows as history — `one_live_per_studio` is unique only
  // `where status <> 'released'` — so a studio has at most one LIVE row and
  // unboundedly many released ones. An earlier revision excluded released rows
  // outright, which made "released, no replacement yet" render as "No sender
  // configured" and left the presenter's `released` branch UNREACHABLE. The
  // per-status loop above still passed, which is the part that makes this worth
  // pinning: the suite was proving a state production could not show.

  function clientReturning(rows: StudioSmsSenderState[]) {
    const captured: { column?: string; opts?: unknown; limit?: number } = {};
    const chain = {
      order(column: string, opts: unknown) {
        captured.column = column;
        captured.opts = opts;
        return chain;
      },
      limit(n: number) {
        captured.limit = n;
        return chain;
      },
      async maybeSingle() {
        return { data: rows[0] ?? null, error: null };
      },
    };
    return {
      captured,
      client: {
        from: () => ({ select: () => ({ eq: () => chain }) }),
      } as never,
    };
  }

  it("orders so the live row wins and the newest released row is the fallback", async () => {
    // `released_evidence_check` makes "live" and "released_at IS NULL" the same
    // set, so NULLS FIRST + DESC is exactly that precedence in one round trip.
    const { captured, client } = clientReturning([]);
    await readOwnStudioSmsSender(client, "s");
    expect(captured.column).toBe("released_at");
    expect(captured.opts).toEqual({ ascending: false, nullsFirst: true });
    expect(captured.limit).toBe(1);
  });

  it("does not filter released rows out of the query", () => {
    // The mechanism, at the source: a `.neq("status", "released")` here is what
    // made the branch unreachable.
    const src = read("lib/sms/sender-status.ts");
    expect(src).not.toMatch(/\.neq\(\s*"status"\s*,\s*"released"\s*\)/);
  });

  it("a released row reaches the presenter and renders its own state", async () => {
    const released = row({
      status: "released",
      phone_number: "+15555550123",
      released_at: "2026-09-20T00:00:00Z",
    });
    const { client } = clientReturning([released]);
    const result = await readOwnStudioSmsSender(client, "s");
    expect(result).toEqual({ ok: true, sender: released });

    const view = presentSenderStatus(result);
    expect(view.status).toBe("released");
    expect(view.headline).toBe("Number released");
    expect(view.headline).not.toBe("No sender configured");
    expect(view.phoneNumber).toBe("+15555550123");
  });
});

/**
 * `phone_number` IS A RECORD, NOT A HISTORY (#749 review, P2 x2).
 *
 * The first revision of this block only stopped the panel over-claiming in one
 * direction — saying a number was given up when none was recorded. The fix
 * then over-claimed in the OTHER direction, saying the setup "ended before a
 * number was bought". Both are inventions, and the second is the more
 * dangerous one because `provisioning.ts` is built around exactly the case it
 * denies:
 *
 *   - `phone_number` is written ONLY by `finalize`;
 *   - the purchase happens BEFORE finalize, and "the purchase SUCCEEDS and
 *     Hone's finalize write is LOST" is a case the file names in its own
 *     header;
 *   - the claim key is written into the PROVIDER resource so it survives that
 *     lost write, and every retry looks at the provider first precisely so it
 *     ADOPTS a number Hone already owns rather than buying a second one;
 *   - the orchestration carries `mayOwnUnfinalizedResources` to say that Hone
 *     may hold provider resources it never recorded.
 *
 * So a null `phone_number` means ONE thing: Hone has no number recorded. It
 * does not establish that a number was purchased, and it does not establish
 * that none was. The null branches must therefore say nothing about numbers,
 * purchases or provider resources in either direction.
 */
describe("the null branches claim only what the row proves", () => {
  /** Wording that asserts a provider resource EXISTED. */
  const CLAIMS_A_NUMBER = [
    /\bthe number\b/i,
    /\bthis number\b/i,
    /number (was|is being) (given up|released)/i,
    /\bnumber released\b/i,
    /never reused/i,
  ];

  /** Wording that asserts a purchase DID NOT happen — the opposite invention. */
  const CLAIMS_NO_PURCHASE = [
    /\bno number\b/i,
    /\bnone to give up\b/i,
    /nothing to (give up|release)/i,
    /(before|without) (a number|buying)/i,
    /(never|not) (bought|purchased)/i,
    /did not get as far/i,
    /\bno provider resource\b/i,
  ];

  const sentence = (v: { headline: string; detail: string }) =>
    `${v.headline} ${v.detail}`;

  const mustBeNeutral = (v: { headline: string; detail: string }) => {
    for (const claim of [...CLAIMS_A_NUMBER, ...CLAIMS_NO_PURCHASE]) {
      expect(sentence(v), String(claim)).not.toMatch(claim);
    }
  };

  it("1. releasing WITH a known number may name it", () => {
    const v = presentSenderStatus(
      ok(row({ status: "releasing", phone_number: "+15551230000" })),
    );
    expect(v.phoneNumber).toBe("+15551230000");
    expect(v.detail).toMatch(/given up/i);
  });

  it("2. releasing WITHOUT a recorded number is neutral", () => {
    const v = presentSenderStatus(ok(row({ status: "releasing" })));
    expect(v.status).toBe("releasing");
    expect(v.phoneNumber).toBeNull();
    mustBeNeutral(v);
    expect(sentence(v)).toMatch(/sender setup/i);
  });

  it("3. released WITH a known number may name it", () => {
    const v = presentSenderStatus(
      ok(
        row({
          status: "released",
          phone_number: "+15551230000",
          released_at: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    expect(v.phoneNumber).toBe("+15551230000");
    expect(v.headline).toMatch(/number released/i);
    expect(v.detail).toMatch(/never reused/i);
  });

  it("4. released WITHOUT a recorded number is neutral", () => {
    const v = presentSenderStatus(
      ok(row({ status: "released", released_at: "2026-09-20T00:00:00Z" })),
    );
    expect(v.status).toBe("released");
    expect(v.phoneNumber).toBeNull();
    mustBeNeutral(v);
    expect(sentence(v)).toMatch(/sender setup/i);
  });

  /**
   * THE REGRESSION FIXTURE. A purchase that succeeded and a finalize that did
   * not: `provisioning.ts` reports `finalize_conflict` / `finalize_failed`
   * with `mayOwnUnfinalizedResources: true`, and `phone_number` stays null
   * because only `finalize` writes it. Hone may well own a number here.
   *
   * This row is indistinguishable, in stored state, from one that never bought
   * anything — which is the whole point. The presenter may not tell them apart
   * and must not pretend to.
   */
  const purchasedThenFinalizeFailed = (status: "releasing" | "released") =>
    row({
      status,
      phone_number: null,
      last_error_code: "finalize_conflict",
      last_error_at: "2026-09-20T00:00:00Z",
      released_at: status === "released" ? "2026-09-20T00:00:00Z" : null,
    });

  for (const status of ["releasing", "released"] as const) {
    it(`a purchase-succeeded-then-finalize-failed row (${status}) is never called "no number"`, () => {
      const v = presentSenderStatus(ok(purchasedThenFinalizeFailed(status)));
      expect(v.phoneNumber).toBeNull();
      mustBeNeutral(v);
      for (const claim of CLAIMS_NO_PURCHASE) {
        expect(sentence(v), `may own an unfinalized number: ${claim}`).not.toMatch(claim);
      }
    });
  }

  it("the released null branch keeps the current-state answer", () => {
    // Correcting the history half must not drop the half that answers
    // "are my texts going out?".
    const v = presentSenderStatus(
      ok(row({ status: "released", released_at: "2026-09-20T00:00:00Z" })),
    );
    expect(v.detail).toMatch(/shared sender/i);
  });

  it("no null-number release renders a number to the card", () => {
    for (const status of ["releasing", "released"] as const) {
      expect(presentSenderStatus(ok(row({ status }))).phoneNumber, status).toBeNull();
    }
  });

  describe("the guards are not vacuous", () => {
    // Without these, every `not.toMatch` above could pass because the patterns
    // match nothing at all. Each family must fire on the revision it was
    // written to forbid.
    it("CLAIMS_A_NUMBER fires on the original wording", () => {
      const original = {
        headline: "Number released",
        detail:
          "This number was given up and is never reused. Messages are sent using Hone's shared sender.",
      };
      expect(CLAIMS_A_NUMBER.filter((c) => c.test(sentence(original))).length)
        .toBeGreaterThan(0);
    });

    it("CLAIMS_NO_PURCHASE fires on the over-corrected wording", () => {
      const overCorrected = {
        headline: "Setup attempt closed",
        detail:
          "An earlier attempt to set up a sender ended before a number was bought. Messages are sent using Hone's shared sender.",
      };
      expect(
        CLAIMS_NO_PURCHASE.filter((c) => c.test(sentence(overCorrected))).length,
      ).toBeGreaterThan(0);
    });

    it("neither family fires on the shipped neutral wording", () => {
      // The complement of the two assertions above: the guards must be
      // satisfiable, not merely strict.
      for (const status of ["releasing", "released"] as const) {
        mustBeNeutral(presentSenderStatus(ok(row({ status }))));
      }
    });
  });
});
