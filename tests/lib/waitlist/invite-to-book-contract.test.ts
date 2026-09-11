import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WAITLIST_ENTRY_STATUSES } from "@/lib/waitlist/admission-model";
import {
  ADMIT_REFUSAL_PRESENTATION,
  ADMIT_SERVER_REFUSALS,
  ADMIT_SERVER_SUCCESS,
  INVITE_TO_BOOK_FAILURES,
  NO_ADAPTER_BOUND,
  RESEND_MINTS_A_NEW_LINK,
  adapterMissingReason,
  admitResultToOutcome,
  type InviteToBookFailure,
} from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — the contract, checked against the database it claims to wrap
// ===========================================================================
//
// A contract module is types and prose, and both are exactly the kind of thing
// that stays convincing long after it stops being true. So nothing here trusts
// the contract's own comments: the failure union, the atomicity obligations and
// the token ruling are each re-derived from the migration files, and the
// contract is asserted against what they say.
//
// This is the same standard the live removal action learned the hard way. Its
// hand-written result map still spelled migration 0185's vocabulary after 0188
// replaced it, so the two codes 0188 added specifically to tell an operator
// what to do next fell through to "please try again" instead.

const ROOT = process.cwd();

const MIGRATIONS = ["0188_new_client_waitlist_invitations", "0189_waitlist_invitation_wall_clock_expiry", "0190_waitlist_invitation_ttl_anchor"].map(
  (name) => readFileSync(join(ROOT, `supabase/migrations/${name}.sql`), "utf8"),
);

const ALL_SQL = MIGRATIONS.join("\n");

/** The body of one `create or replace function`, from its header to the `$$;`
 *  that closes it. */
function functionBody(name: string): string {
  let found = "";
  for (const sql of MIGRATIONS) {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    if (start === -1) continue;
    const end = sql.indexOf("\n$$;", start);
    // LAST definition wins: 0189 and 0190 each replace functions 0188 defined,
    // and reading the earliest would pin a vocabulary that has been superseded.
    found = sql.slice(start, end === -1 ? undefined : end);
  }
  if (!found) throw new Error(`no definition found for ${name}`);
  return found;
}

/** Every result string a command can return. Covers both spellings the
 *  migrations use — `return 'code'` for the scalar commands and
 *  `return query select 'code'::text` for the ones returning a row. */
function resultCodes(name: string): string[] {
  const body = functionBody(name);
  return [
    ...[...body.matchAll(/return\s+'([a-z_]+)'/g)].map((m) => m[1]),
    ...[...body.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]),
  ];
}

/** The commands every method of the adapter is built from. */
const COMMANDS = [
  "new_client_waitlist_resolve_owner",
  "claim_new_client_waitlist_entry",
  "issue_new_client_waitlist_invitation",
  "release_new_client_waitlist_entry",
  "requeue_new_client_waitlist_entry",
  "expire_new_client_waitlist_invitation",
  "remove_new_client_waitlist_entry",
] as const;

/** Codes that report SUCCESS rather than refusal. `owner`/`ok` come from the
 *  authority resolver, the rest are the commands' own done-states. */
const SUCCESS_CODES = new Set([
  "ok",
  "owner",
  "claimed",
  "invited",
  "released",
  "requeued",
  "expired",
  "removed",
]);

/** The legal status transitions, read from the guard's own tuple list in 0188. */
function legalEdges(): Array<[string, string]> {
  const guard = ALL_SQL.slice(
    ALL_SQL.indexOf("v_legal := (old.status, new.status) in ("),
  );
  const list = guard.slice(0, guard.indexOf(");"));
  return [...list.matchAll(/\(\s*'(\w+)'\s*,\s*'(\w+)'\s*\)/g)].map((m) => [m[1], m[2]]);
}

/**
 * Fewest legal transitions from `from` to `to`, counting AT LEAST ONE edge.
 *
 * The count is a number of COMMANDS, so a path of length zero is not a
 * meaningful answer even when `from === to` — resending lands an entry back on
 * `invited`, and the interesting fact is that getting there costs four
 * transitions, not that it started there. Seeding the search from `from`'s
 * successors rather than from `from` itself is what makes the round trip
 * measurable.
 */
function hops(from: string, to: string): number {
  const edges = legalEdges();
  const seen = new Set<string>();
  let frontier = [from];
  let distance = 0;
  while (frontier.length > 0 && distance <= WAITLIST_ENTRY_STATUSES.length) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const [a, b] of edges) {
        if (a !== node) continue;
        if (b === to) return distance + 1;
        if (!seen.has(b)) {
          seen.add(b);
          next.push(b);
        }
      }
    }
    frontier = next;
    distance += 1;
  }
  return Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------

describe("the transition table this contract is built on", () => {
  it("reads as the twelve edges 0188 declares", () => {
    const edges = legalEdges();
    expect(edges).toHaveLength(12);
    // Non-vacuity for every derivation below: the parse must have found real
    // statuses rather than an empty or malformed list.
    for (const [from, to] of edges) {
      expect(WAITLIST_ENTRY_STATUSES).toContain(from);
      expect(WAITLIST_ENTRY_STATUSES).toContain(to);
    }
  });
});

describe("every failure the adapter may report is one a command can produce", () => {
  it("covers each shipped refusal code", () => {
    const refusals = new Set<string>();
    for (const command of COMMANDS) {
      const codes = resultCodes(command);
      // Non-vacuity: a slice that found no codes would make this whole suite
      // pass by describing nothing.
      expect(codes.length, `${command} produced no result codes`).toBeGreaterThan(2);
      for (const code of codes) if (!SUCCESS_CODES.has(code)) refusals.add(code);
    }
    expect(refusals.size).toBeGreaterThan(8);

    const declared = new Set<string>(INVITE_TO_BOOK_FAILURES);
    const missing = [...refusals].filter((c) => !declared.has(c)).sort();
    expect(
      missing,
      "a shipped command can refuse with a code the adapter contract cannot carry",
    ).toEqual([]);
  });

  it("adds exactly the two codes no command can produce, and says so", () => {
    const produced = new Set(COMMANDS.flatMap((c) => resultCodes(c)));
    const invented = INVITE_TO_BOOK_FAILURES.filter((c) => !produced.has(c)).sort();
    // `scope_not_supported` is the contract's own: no shipped command carries a
    // service or booking window yet, so an adapter that cannot honour one needs
    // a way to refuse rather than widen the invitation silently.
    // `unavailable` covers transport and unmapped database errors.
    expect(invented).toEqual(["scope_not_supported", "unavailable"]);
  });

  it("never reports a success code as a failure", () => {
    for (const code of INVITE_TO_BOOK_FAILURES as ReadonlyArray<string>) {
      expect(SUCCESS_CODES.has(code), `"${code}" is a success code`).toBe(false);
    }
  });
});

describe("which adapter methods MUST be atomic, derived from the edge list", () => {
  it("invite-to-book is compound from `waiting` and single-hop from `claimed`", () => {
    // `issue` refuses anything but `claimed`, so a waiting person must be
    // claimed first — and a partial application strands them at `claimed`,
    // which is the one state this surface never produces on purpose.
    expect(functionBody("issue_new_client_waitlist_invitation")).toContain("not_claimed");
    expect(hops("waiting", "invited")).toBe(2);
    expect(hops("claimed", "invited")).toBe(1);
  });

  it("returning an invited person to the queue is compound, because the edge does not exist", () => {
    // `invited -> waiting` is NOT legal. The dead invitation has to be stamped
    // before the entry can move, which is why `returnToWaitlist` has two paths
    // behind one method and the caller chooses neither.
    expect(legalEdges()).not.toContainEqual(["invited", "waiting"]);
    expect(hops("invited", "waiting")).toBe(2);
    // From a closed invitation it is a single requeue.
    expect(hops("expired", "waiting")).toBe(1);
    expect(hops("released", "waiting")).toBe(1);
  });

  it("resending is the longest compound of them all", () => {
    // release -> requeue -> claim -> issue. Four commands, and every
    // intermediate state is one a practitioner has no way to have asked for.
    expect(hops("invited", "invited")).toBe(4);
  });

  it("cancelling is a single hop, and is the only way to end a live invitation", () => {
    expect(hops("invited", "released")).toBe(1);
    // Recording an expiry is not cancellation: `expire` refuses until the
    // window has actually run out, so it can never serve as an early exit.
    expect(functionBody("expire_new_client_waitlist_invitation")).toContain("not_expired");
  });

  it("leaves converted and removed with no way back", () => {
    for (const terminal of ["converted", "removed"] as const) {
      const out = legalEdges().filter(([from]) => from === terminal);
      expect(out, `${terminal} must be terminal`).toEqual([]);
    }
  });
});

describe("resend cannot re-deliver the existing link, and the schema is why", () => {
  it("stores only the token's digest", () => {
    const table = ALL_SQL.slice(
      ALL_SQL.indexOf("create table if not exists public.new_client_waitlist_invitations"),
    );
    const columns = table.slice(0, table.indexOf("\n);"));
    expect(columns).toContain("token_hash");
    // No column holds the raw token, so once the issuing transaction returns it
    // is gone. "Resend" therefore necessarily mints a new one on a new window —
    // a product-visible consequence, which the composer discloses.
    expect(/^\s*(raw_token|token)\s+text/m.test(columns)).toBe(false);
    expect(RESEND_MINTS_A_NEW_LINK).toMatch(/new booking link/i);
    expect(RESEND_MINTS_A_NEW_LINK).toMatch(/stops working/i);
  });

  it("mints the token in the issuing statement and returns it once", () => {
    const issue = functionBody("issue_new_client_waitlist_invitation");
    expect(issue).toContain("gen_random_bytes");
    expect(issue).toContain("digest");
    // The insert takes the hash, never the raw value.
    expect(issue).toMatch(/values[\s\S]*v_hash/);
  });
});

describe("the expiry bound the composer offers is the command's own", () => {
  it("refuses out of range rather than clamping", () => {
    const issue = functionBody("issue_new_client_waitlist_invitation");
    expect(issue).toContain("invalid_ttl");
    // 1 hour .. 7 days, stated in the command itself.
    expect(issue).toMatch(/v_ttl\s*<\s*1\s*or\s*v_ttl\s*>\s*168/);
  });
});

describe("nothing here can be mistaken for a working adapter", () => {
  it("binds no adapter", () => {
    expect(NO_ADAPTER_BOUND).toBeNull();
  });

  it("explains an unwired control by naming that control", () => {
    // Finding C: the copy must describe the adjacent action, never "sending"
    // in the abstract on a control that sends nothing.
    const reason = adapterMissingReason("Return to waitlist");
    expect(reason).toContain("Return to waitlist");
    expect(reason.toLowerCase()).not.toContain("sending is not available");
  });

  it("keeps the failure list exhaustive at the type level", () => {
    // A code added to the union without a home here is a compile error rather
    // than a silent fall-through to a generic message.
    const exhaustive: Record<InviteToBookFailure, true> = Object.fromEntries(
      INVITE_TO_BOOK_FAILURES.map((c) => [c, true]),
    ) as Record<InviteToBookFailure, true>;
    expect(Object.keys(exhaustive).sort()).toEqual([...INVITE_TO_BOOK_FAILURES].sort());
  });
});

// ---------------------------------------------------------------------------

describe("the admission command's result vocabulary is carried in full", () => {
  // INDEPENDENT ORACLE. Read by hand out of WAIT-ADMIT-01's
  // `0193_waitlist_admission_authority.sql` at exact head
  // `519cfe6cf7e3281d4c445a35f34653c10b054100`, plus the two callees whose
  // refusals it re-emits. It is deliberately NOT derived from
  // ADMIT_SERVER_REFUSALS: a list compared against itself proves only that it
  // equals itself, and this suite has already been taught that lesson once.
  //
  // 0193 is not on this branch, so `resultCodes()` above cannot reach it. That
  // is a stated bound, not an oversight — and it is why the oracle carries the
  // SHA it was read at.
  const EXPECTED_ADMIT_RESULTS = {
    success: "admitted",
    // returned directly by admit_new_client_waitlist_entry
    own: ["unknown_studio", "not_found", "not_admissible"],
    // raised as WA001 out of claim_new_client_waitlist_entry (0189) and
    // re-emitted by admit's own exception handler as SQLERRM
    fromClaim: ["invalid_input", "not_found", "not_waiting"],
    // the same channel, out of issue_scoped_new_client_waitlist_invitation
    fromIssueScoped: [
      "already_declined_offer",
      "invalid_scope_dates",
      "invalid_service",
      "invalid_weekdays",
      "no_round_open",
      "round_full",
      "unknown_studio",
    ],
    // which 0192 in turn passes through from issue_new_client_waitlist_invitation
    fromIssueScopedPassthrough: [
      "already_invited",
      "invalid_input",
      "invalid_ttl",
      "not_claimed",
      "not_found",
    ],
  } as const;

  const expectedRefusals = [
    ...new Set<string>([
      ...EXPECTED_ADMIT_RESULTS.own,
      ...EXPECTED_ADMIT_RESULTS.fromClaim,
      ...EXPECTED_ADMIT_RESULTS.fromIssueScoped,
      ...EXPECTED_ADMIT_RESULTS.fromIssueScopedPassthrough,
    ]),
  ].sort();

  it("represents every result the command can return", () => {
    // Non-vacuity: the union must be genuinely larger than the command's own
    // literals, or the derivation collapsed back to reading `return query`.
    expect(expectedRefusals.length).toBe(14);
    expect(EXPECTED_ADMIT_RESULTS.own.length).toBeLessThan(expectedRefusals.length);

    expect(ADMIT_SERVER_SUCCESS).toBe(EXPECTED_ADMIT_RESULTS.success);
    expect(
      [...ADMIT_SERVER_REFUSALS].sort(),
      "a result admit_new_client_waitlist_entry can return is not represented",
    ).toEqual(expectedRefusals);

    // The two the integration finding named, pinned individually so a rename
    // cannot quietly drop them into a larger diff.
    expect(ADMIT_SERVER_REFUSALS).toContain("unknown_studio");
    expect(ADMIT_SERVER_REFUSALS).toContain("not_admissible");
  });

  it("gives every server result a presentation, and none of them success", () => {
    expect(Object.keys(ADMIT_REFUSAL_PRESENTATION).sort()).toEqual(expectedRefusals);

    for (const refusal of ADMIT_SERVER_REFUSALS) {
      const shown = ADMIT_REFUSAL_PRESENTATION[refusal];
      // Presentation may normalise, but only ever onto a code the practitioner
      // surface already knows — never an invented string.
      expect(
        INVITE_TO_BOOK_FAILURES as ReadonlyArray<string>,
        `${refusal} maps to a code outside the contract`,
      ).toContain(shown);

      const outcome = admitResultToOutcome(refusal, "2026-09-12T10:00:00.000Z");
      expect(outcome.ok, `${refusal} must never read as success`).toBe(false);
    }
  });

  it("normalises the two unactionable refusals to `unavailable`", () => {
    // Neither has a composer edit or a retry that changes the answer, so the
    // practitioner is told the send is unavailable rather than shown a database
    // reason they cannot act on.
    expect(ADMIT_REFUSAL_PRESENTATION.unknown_studio).toBe("unavailable");
    expect(ADMIT_REFUSAL_PRESENTATION.not_admissible).toBe("unavailable");

    expect(admitResultToOutcome("unknown_studio", null)).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(admitResultToOutcome("not_admissible", null)).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("keeps the refusals the composer CAN fix distinguishable", () => {
    // Normalising these to `unavailable` would tell a practitioner to retry a
    // send that will refuse identically every time. The scope they expressed is
    // the thing to change, and the contract already has a word for that.
    for (const scoped of ["invalid_service", "invalid_scope_dates", "invalid_weekdays"] as const) {
      expect(ADMIT_REFUSAL_PRESENTATION[scoped]).toBe("scope_not_supported");
    }
    // And the ones with exact counterparts keep them rather than collapsing.
    expect(ADMIT_REFUSAL_PRESENTATION.not_found).toBe("not_found");
    expect(ADMIT_REFUSAL_PRESENTATION.already_invited).toBe("already_invited");
  });

  it("fails closed on anything it does not recognise", () => {
    // A server result added without updating this contract.
    expect(admitResultToOutcome("newly_invented_refusal", null)).toEqual({
      ok: false,
      code: "unavailable",
    });
    // Malformed runtime values. None of these may produce a success.
    for (const junk of [null, undefined, 42, {}, [], true, ""]) {
      const outcome = admitResultToOutcome(junk, "2026-09-12T10:00:00.000Z");
      expect(outcome.ok, `${String(junk)} must not read as success`).toBe(false);
      expect(outcome).toEqual({ ok: false, code: "unavailable" });
    }
    // Inherited property names must not resolve through the prototype chain.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(admitResultToOutcome(inherited, null)).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
  });

  it("never synthesises an expiry for a success it cannot date", () => {
    expect(admitResultToOutcome("admitted", "2026-09-12T10:00:00.000Z")).toEqual({
      ok: true,
      expiresAt: "2026-09-12T10:00:00.000Z",
    });
    // 0190's correction: the window belongs to the issuing instant, which only
    // the database observes. An undated success is malformed, not successful.
    for (const missing of [null, undefined, "", "   ", 0]) {
      expect(admitResultToOutcome("admitted", missing)).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
  });
});
