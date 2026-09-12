import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

// ===========================================================================
// WAIT INTEGRATION-01 — THE SEAMS THIS REBUILD ADDED
// ===========================================================================
//
// Three bindings that no component branch can hold, each proved against the
// real database with only the external email provider faked:
//
//   A. the proof-request limiter   #680 policy  -> #686 call site
//   C. the practitioner live-row   0192 index   -> production page predicate
//   B. the invite-to-book adapter  #683 contract -> #685 admit_ command
//
// Each has a negative control that turns RED when its rule is removed.

type SentMail = { payload: { subject: string; text: string } };

const hoisted = vi.hoisted(() => ({
  sends: [] as SentMail[],
  jar: new Map<string, string>(),
  // The limiter's verdict, so a refusal can be exercised without a Redis.
  proofGateAllowed: { value: true },
  proofGateCalls: [] as Array<{ studioId: string; invitationId: string }>,
  requestHeaders: new Headers({ "x-forwarded-for": "203.0.113.21" }),
}));

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => null,
  resend: {
    emails: {
      send: async (payload: SentMail["payload"]) => {
        hoisted.sends.push({ payload });
        return { data: { id: `msg_${hoisted.sends.length}` }, error: null };
      },
    },
  },
}));

// THE LIMITER'S BACKEND IS THE FAKE, NOT THE LIMITER'S PLACE IN THE FLOW.
//
// `limitWaitlistProofRequest` fails OPEN when no Redis is configured — by
// #680's own classified ruling — so against the real module every request is
// allowed and a "refusal costs no challenge" assertion could never fail. What
// is stubbed here is the VERDICT a Redis would have returned. Everything the
// binding does with that verdict, and everything downstream of it, is real.
vi.mock("@/lib/rate-limit/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit/public")>();
  return {
    ...actual,
    limitWaitlistProofRequest: async (args: {
      headers: Headers;
      studioId: string;
      invitationId: string;
    }) => {
      hoisted.proofGateCalls.push({
        studioId: args.studioId,
        invitationId: args.invitationId,
      });
      return hoisted.proofGateAllowed.value
        ? { allowed: true as const }
        : { allowed: false as const, retryAfterSeconds: 60 };
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      hoisted.jar.has(name) ? { name, value: hoisted.jar.get(name) } : undefined,
    set: (name: string, value: string) => {
      if (value === "") hoisted.jar.delete(name);
      else hoisted.jar.set(name, value);
    },
  }),
  headers: async () => hoisted.requestHeaders,
}));

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  secret: process.env.APPOINTMENT_SIGNING_SECRET,
};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.APPOINTMENT_SIGNING_SECRET = "wait-integration-seams-secret";
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.APPOINTMENT_SIGNING_SECRET = savedEnv.secret;
  await closePool();
});

beforeEach(() => {
  hoisted.sends.length = 0;
  hoisted.proofGateCalls.length = 0;
  hoisted.jar.clear();
  hoisted.proofGateAllowed.value = true;
});

// ---------------------------------------------------------------------------

type Offer = {
  studio: SeededStudio;
  serviceId: string;
  entryId: string;
  invitationId: string;
  token: string;
  email: string;
};

async function seedOffer(label: string): Promise<Offer> {
  const studio = await seedStudio(label);
  await adminQuery(
    `update public.studios set slug = $2, timezone = 'UTC' where id = $1`,
    [studio.studioId, `wl-s-${studio.studioId.slice(0, 8)}`],
  );
  const svc = await adminQuery(
    `insert into public.services
       (studio_id, name, default_duration_minutes, price_cents, active, modality)
     values ($1, $2, 60, 10000, true, 'consultation') returning id`,
    [studio.studioId, `Consultation ${label}`],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '09:00', '17:00', null from generate_series(0, 6) g
     on conflict (studio_id, day_of_week, practitioner_id) do update
        set is_open = true, open_time = '09:00', close_time = '17:00'`,
    [studio.studioId],
  );
  const round = await adminQuery(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
    [studio.studioId, studio.userId, 10],
  );
  expect(round.rows[0].result, "the fixture must actually open a round").toBe("opened");

  const email = `p-${label}-${studio.studioId.slice(0, 8)}@harness.local`;
  const joined = await adminQuery(
    `select result, entry_id from public.join_new_client_waitlist($1,$2,$3,$4)`,
    [studio.studioId, `Prospect ${label}`, email, "+15550000123"],
  );
  const entryId = joined.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    studio.studioId,
    entryId,
    studio.userId,
  ]);
  const issued = await adminQuery(
    `select result, raw_token, invitation_id
       from public.issue_scoped_new_client_waitlist_invitation(
              $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
    [studio.studioId, entryId, studio.userId, svc.rows[0].id],
  );
  expect(issued.rows[0].result).toBe("issued");
  return {
    studio,
    serviceId: svc.rows[0].id as string,
    entryId,
    email,
    token: issued.rows[0].raw_token as string,
    invitationId: issued.rows[0].invitation_id as string,
  };
}

const actions = () => import("@/app/invitation/[token]/actions");

/** Source minus comment lines, so a file's own changelog cannot satisfy a guard
 *  that the thing it describes is absent. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const challengeHash = async (invitationId: string) =>
  (
    await adminQuery(
      `select proof_challenge_hash from public.new_client_waitlist_invitations where id = $1`,
      [invitationId],
    )
  ).rows[0].proof_challenge_hash;

// ===========================================================================
describe("A — the proof-request limiter is actually in the flow", () => {
  it("a refusal costs NO challenge and NO mail", async () => {
    const offer = await seedOffer("limit-deny");
    const { requestInvitationProofAction } = await actions();
    hoisted.proofGateAllowed.value = false;

    const out = await requestInvitationProofAction(offer.token);

    // The limiter was consulted with SERVER-RESOLVED row ids — never the token.
    expect(hoisted.proofGateCalls).toHaveLength(1);
    expect(hoisted.proofGateCalls[0].invitationId).toBe(offer.invitationId);
    expect(hoisted.proofGateCalls[0].studioId).toBe(offer.studio.studioId);
    expect(hoisted.proofGateCalls[0].invitationId).not.toBe(offer.token);

    // THE POINT OF THE ORDERING: nothing was minted and nothing was sent.
    // Minting retires the previous code in the recipient's inbox, so a throttled
    // request that still minted would punish the person being protected.
    expect(await challengeHash(offer.invitationId)).toBeNull();
    expect(hoisted.sends).toHaveLength(0);

    // The offer survives — this is a throttle, not a terminal state.
    expect(out.kind).toBe("proof");
  });

  it("an allowed request DOES mint and send — so the refusal above is not vacuous", async () => {
    const offer = await seedOffer("limit-allow");
    const { requestInvitationProofAction } = await actions();
    hoisted.proofGateAllowed.value = true;

    const out = await requestInvitationProofAction(offer.token);
    expect(hoisted.proofGateCalls).toHaveLength(1);
    expect(await challengeHash(offer.invitationId)).not.toBeNull();
    expect(hoisted.sends).toHaveLength(1);
    expect(out.kind).toBe("proof");
    if (out.kind === "proof") expect(out.stage.kind).toBe("sent");
  });

  it("the limiter is wired at the call site, keyed on the invitation", () => {
    // Source tripwire beside the behavioural controls: the mock above proves the
    // BINDING behaves, this proves the real limiter is what it binds to.
    const src = readFileSync("app/invitation/[token]/actions.ts", "utf8");
    expect(src).toContain("limitWaitlistProofRequest");
    expect(src).toContain("invitationId: ctx.resolve.invitation.invitationId");
  });
});

// ===========================================================================
describe("C — a declined invitation is not a live invitation", () => {
  it("the app predicate matches 0192's index, and the OLD one did not", async () => {
    const offer = await seedOffer("declined");

    // Decline it through the real authority: prove, then decline.
    const begun = await adminQuery(
      `select raw_challenge from public.begin_waitlist_invitation_proof($1, 15)`,
      [offer.token],
    );
    const done = await adminQuery(
      `select raw_capability from public.complete_waitlist_invitation_proof($1,$2)`,
      [offer.token, begun.rows[0].raw_challenge],
    );
    const declined = await adminQuery(
      `select result from public.decline_new_client_waitlist_invitation($1,$2)`,
      [offer.token, done.rows[0].raw_capability],
    );
    expect(declined.rows[0].result).toBe("declined");

    // THE OLD THREE-COLUMN PREDICATE still calls it live. This is the defect,
    // reproduced rather than described — and it is what the page asked for.
    const three = await adminQuery(
      `select entry_id from public.new_client_waitlist_invitations
        where studio_id = $1 and entry_id = $2
          and redeemed_at is null and expired_at is null and released_at is null`,
      [offer.studio.studioId, offer.entryId],
    );
    expect(three.rows).toHaveLength(1);

    // THE FOUR-COLUMN PREDICATE — 0192's index, and now the page's — does not.
    const four = await adminQuery(
      `select entry_id from public.new_client_waitlist_invitations
        where studio_id = $1 and entry_id = $2
          and redeemed_at is null and expired_at is null and released_at is null
          and declined_at is null`,
      [offer.studio.studioId, offer.entryId],
    );
    expect(four.rows).toHaveLength(0);

    // And the DATABASE agrees the entry is free: the unique index permits a new
    // live row, which is the whole reason 0192 widened it.
    const idx = await adminQuery(
      `select indexdef from pg_indexes
        where indexname = 'new_client_waitlist_invitations_one_live_per_entry'`,
    );
    expect(idx.rows[0].indexdef).toContain("declined_at IS NULL");
  });

  it("the practitioner page asks the four-column question", () => {
    const src = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");
    // Strip comments so the file's own explanation of the defect cannot satisfy
    // the guard that the defect is fixed.
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).toContain('.is("declined_at", null)');
  });
});

// ===========================================================================
// P1 3990868492 — the one raw token is spent on delivery, and nowhere else
// ===========================================================================
describe("initial invitation delivery", () => {
  it("admission and delivery are SEPARATE truths", async () => {
    const { __deliveryStateFromDispositionForTest: mapDisposition } = await import(
      "@/lib/waitlist/invite-to-book-adapter"
    );
    // #680's custody verdict -> #683's three words.
    expect(mapDisposition("yes")).toBe("accepted");
    expect(mapDisposition("no")).toBe("refused");
    expect(mapDisposition("unknown")).toBe("unknown");
    // FAIL CLOSED. An unreadable verdict may not become a claim either way.
    expect(mapDisposition(undefined)).toBe("unknown");
    expect(mapDisposition("delivered")).toBe("unknown");
  });

  it("a delivery refusal can NEVER become an admission refusal", () => {
    // The rule stated as a shape test over the source: the only `state:
    // "refused"` returns in the adapter are produced by the two pre-command
    // helpers. Nothing downstream of the commit can reach that arm, because
    // `inviteToBook` returns a `committed` literal on every post-commit path.
    const code = stripComments(readFileSync("lib/waitlist/invite-to-book-adapter.ts", "utf8"));

    // THE ARM AFTER THE COMMIT MAY NOT CONTAIN A REFUSAL AT ALL.
    //
    // An earlier version of this test only checked that `state: "committed"`
    // and the helper's return type were present, and stayed GREEN when a
    // `delivery === "refused"` branch was made to return `state: "refused"`.
    // Caught by running the mutation: the real property is that the whole
    // post-commit region has no refusal arm to reach.
    const committedArm = code.slice(
      code.indexOf("const expiresAt = readString(row"),
      code.indexOf("async cancelInvitation"),
    );
    expect(committedArm.length).toBeGreaterThan(200);
    expect(committedArm).not.toContain('state: "refused"');
    expect(committedArm).not.toContain("INDETERMINATE_ADMISSION");
    expect(committedArm).toContain('state: "committed"');

    // And the delivery helper's return type is the delivery vocabulary only, so
    // it cannot express an admission verdict even if a caller wanted one.
    expect(code).toContain("Promise<InvitationDeliveryState>");
  });

  it("the raw token reaches the mail constructor and NOTHING else", () => {
    const code = stripComments(readFileSync("lib/waitlist/invite-to-book-adapter.ts", "utf8"));

    // IT IS ACTUALLY SPENT. This is the load-bearing half, and the first
    // version of this test did not have it: asserting only that the token is
    // never logged or returned stayed GREEN when the delivery call was deleted
    // outright, because a discarded token leaks nothing either. Caught by
    // running the mutation. The committed arm must PASS the token to delivery
    // and take its `delivery` value from the result — a literal there means the
    // send is gone.
    const committedArm = code.slice(
      code.indexOf("const expiresAt = readString(row"),
      code.indexOf("async cancelInvitation"),
    );
    expect(committedArm).toMatch(/await deliverInvitation\(\{/);
    expect(committedArm).toMatch(/\n\s*rawToken,/);
    expect(committedArm).toMatch(/return \{ state: "committed", expiresAt, delivery \};/);

    // It is read from the committed row...
    expect(code).toContain('readString(row, "raw_token")');
    // ...and the ONLY place it is used is the invitation URL handed to #680.
    const uses = [...code.matchAll(/rawToken/g)].length;
    // read + pass into deliverInvitation + destructure + the URL = a small,
    // enumerable set. A larger count means it leaked into a new expression.
    expect(uses).toBeLessThanOrEqual(5);
    expect(code).toContain("invitationUrl: `${origin}/invitation/${args.rawToken}`");

    // NOT persisted, NOT logged, NOT returned, NOT attached to an error.
    expect(code).not.toMatch(/console\.[a-z]+\([^)]*rawToken/);
    expect(code).not.toMatch(/(insert|update|upsert)[^\n]*rawToken/i);
    expect(code).not.toMatch(/return[^\n]*rawToken/);
    expect(code).not.toMatch(/throw[^\n]*rawToken/);
    // And the practitioner-facing outcome type has no field that could carry it.
    const contract = readFileSync("lib/waitlist/invite-to-book-contract.ts", "utf8");
    const outcome = contract.slice(
      contract.indexOf("export type InvitationOutcome"),
      contract.indexOf("export const INDETERMINATE_ADMISSION"),
    );
    expect(outcome).not.toMatch(/token/i);
  });

  it("a LOST RPC answer is indeterminate, never a definite refusal", () => {
    // The most expensive lie this seam could tell. A request may reach
    // PostgreSQL, commit the admission, consume the round's allowance, and lose
    // its HTTP response. Calling that `refused` invites the practitioner to
    // press again — and the one-time token from the first attempt is already
    // gone, so the second burns capacity on someone who cannot be handed a link.
    const code = stripComments(readFileSync("lib/waitlist/invite-to-book-adapter.ts", "utf8"));
    const preCommit = code.slice(
      code.indexOf("const { data, error } = await admin.rpc"),
      code.indexOf("const expiresAt = readString(row"),
    );
    expect(preCommit.length).toBeGreaterThan(50);
    // The transport-error arm returns the indeterminate singleton, and does NOT
    // construct a refusal.
    expect(preCommit).toMatch(/if \(error\) return INDETERMINATE_ADMISSION;/);
    expect(preCommit).not.toContain('state: "refused"');

    // NO BLIND RETRY AND NO INFERRED RECONCILIATION. "A live invitation exists"
    // does not prove THIS attempt made it — a concurrent operator is enough to
    // make that inference wrong — so nothing here may read invitation state to
    // decide the answer.
    expect(preCommit).not.toMatch(/one_live_per_entry|\.from\(/);
  });

  it("BOTH instants come from the committed row, neither reconstructed", () => {
    const code = stripComments(readFileSync("lib/waitlist/invite-to-book-adapter.ts", "utf8"));
    expect(code).toContain('readString(row, "issued_at")');
    expect(code).toContain('readString(row, "expires_at")');
    // The adjudicated ban: no derivation from the other end, no second clock in
    // the delivery path.
    expect(code).not.toMatch(/expiresAt[^\n]*-[^\n]*(ttl|TTL|expiresInHours)/);
    expect(code).not.toMatch(/issuedAt:\s*new Date\(\)/);
  });
});

// ===========================================================================
// PHASE 7 — CROSS-COMPONENT EXHAUSTIVENESS
// ===========================================================================
//
// #683 CANNOT PROVE THIS AND SAYS SO. Its own contract calls
// `ADMIT_SERVER_REFUSALS` "A SNAPSHOT ... NOT a live guarantee", because 0193
// is not an ancestor of that branch and nothing there can observe what the
// command returns. #689 has BOTH components, so the live proof is owned here.
//
// The vocabulary is derived from the SQL, not from a list retyped here. Nothing
// generic is parsed: the three functions that can produce `admit_`'s result are
// read by name, and only two literal spellings are matched.
describe("the CURRENT 0193 admit_ vocabulary is fully mapped", () => {
  const ROOT = process.cwd();
  const SOURCES = [
    "0188_new_client_waitlist_invitations",
    "0189_waitlist_invitation_wall_clock_expiry",
    "0192_waitlist_recipient_proof_authority",
    "0193_waitlist_admission_authority",
  ].map((n) => readFileSync(`${ROOT}/supabase/migrations/${n}.sql`, "utf8"));

  /** The last definition of one function. 0189 replaces what 0188 defined, and
   *  reading the earliest would pin a superseded vocabulary. */
  function functionBody(name: string): string {
    let found = "";
    for (const sql of SOURCES) {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      if (start === -1) continue;
      const end = sql.indexOf("\n$$;", start);
      found = sql.slice(start, end === -1 ? undefined : end);
    }
    if (!found) throw new Error(`no definition found for ${name}`);
    return found;
  }

  /** Both spellings the migrations use: `return 'code'` for scalar commands and
   *  `'code'::text` for the ones returning a row. */
  function resultCodes(name: string): string[] {
    const body = functionBody(name);
    return [
      ...[...body.matchAll(/return\s+'([a-z_]+)'/g)].map((m) => m[1]),
      ...[...body.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]),
    ];
  }

  /**
   * Everything `admit_` can put in its `result` column.
   *
   * Its own literals, PLUS the two commands it delegates to. `admit_` raises
   * WA001 carrying the inner refusal and its handler returns `SQLERRM` verbatim,
   * so a delegate's vocabulary IS `admit_`'s vocabulary — the indirection that
   * makes this impossible to see from either component alone.
   */
  function admitVocabulary(): Set<string> {
    // THE DELEGATES' SUCCESS SENTINELS DO NOT PASS THROUGH, and they are derived
    // rather than assumed. `admit_` propagates a delegate's answer ONLY on the
    // failing branch — `if v_claim <> 'claimed'`, `if v_issue.result <> 'issued'`
    // — so the values it compares against are precisely the ones that never
    // reach its result column. Reading them out of those comparisons keeps this
    // exclusion tied to the SQL: rename a sentinel and the extraction follows,
    // where a hardcoded pair would silently start dropping a real refusal.
    const admitBody = functionBody("admit_new_client_waitlist_entry");
    const sentinels = new Set(
      [...admitBody.matchAll(/<>\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    // THREE delegates, not two. `new_client_waitlist_resolve_owner` is the
    // third: `if v_code <> 'ok'` returns its code directly, so its refusals
    // (not_a_member, not_owner, ...) are also part of this vocabulary. Missing
    // it is exactly the kind of hop that makes the set unknowable from either
    // component alone, which is why the sentinel set is asserted rather than
    // assumed — a new delegate changes it and this line says so.
    expect(sentinels, "admit_ must compare against its delegates' success codes")
      .toEqual(new Set(["ok", "claimed", "issued"]));

    const all = new Set([
      ...resultCodes("admit_new_client_waitlist_entry"),
      ...resultCodes("new_client_waitlist_resolve_owner"),
      ...resultCodes("claim_new_client_waitlist_entry"),
      ...resultCodes("issue_scoped_new_client_waitlist_invitation"),
    ]);
    for (const s of sentinels) all.delete(s);
    return all;
  }

  it("every current result maps to committed or refused — none falls through", async () => {
    const { ADMIT_SERVER_SUCCESS, ADMIT_REFUSAL_PRESENTATION } = await import(
      "@/lib/waitlist/invite-to-book-contract"
    );
    const { ADMIT_AUTHORITY_REFUSALS } = await import(
      "@/lib/waitlist/invite-to-book-adapter"
    );
    const vocabulary = admitVocabulary();
    // Sanity: the extractor must actually find something, or this whole
    // describe passes by finding nothing.
    expect(vocabulary.size).toBeGreaterThan(8);
    expect(vocabulary.has(ADMIT_SERVER_SUCCESS)).toBe(true);

    // THE MAPPING IS THE UNION OF BOTH TABLES, and that is the point.
    //
    // #683's `ADMIT_REFUSAL_PRESENTATION` covers what it could see. It does NOT
    // enumerate `not_owner` / `not_a_member`, which `admit_` propagates verbatim
    // from `new_client_waitlist_resolve_owner` — a hop invisible from that
    // branch, and exactly what its "A SNAPSHOT ... NOT a live guarantee" header
    // warns about. #689's `ADMIT_AUTHORITY_REFUSALS` supplies precisely those,
    // so the assembled runtime is truthful today; the contract fix remains
    // #683's.
    //
    // Asserting the UNION rather than #683's table alone means nothing rots the
    // day #683 adds them: the codes move from one table to the other and this
    // still passes, while any genuinely NEW result still fails.
    const mappedHere = new Set([
      ...Object.keys(ADMIT_REFUSAL_PRESENTATION),
      ...Object.keys(ADMIT_AUTHORITY_REFUSALS),
    ]);
    const unmapped = [...vocabulary]
      .filter((c) => c !== ADMIT_SERVER_SUCCESS)
      .filter((c) => !mappedHere.has(c))
      .sort();
    expect(unmapped, `unmapped 0193 results: ${unmapped.join(", ")}`).toEqual([]);

    // AND THE SUPPLEMENT IS NOT A CATCH-ALL. It carries exactly the authority
    // codes one named command can return — never the whole failure union, which
    // would let a future result borrow an unrelated name and become a confident
    // refusal.
    expect(Object.keys(ADMIT_AUTHORITY_REFUSALS).sort()).toEqual([
      "not_a_member",
      "not_owner",
    ]);
  });

  it("a NEW server result would turn this RED — the control is load-bearing", async () => {
    const { ADMIT_REFUSAL_PRESENTATION } = await import(
      "@/lib/waitlist/invite-to-book-contract"
    );
    const { ADMIT_AUTHORITY_REFUSALS } = await import(
      "@/lib/waitlist/invite-to-book-adapter"
    );
    // The SAME union the real check uses, so this control cannot pass by
    // testing a narrower table than production consults.
    const presentationKeys: Record<string, unknown> = {
      ...ADMIT_REFUSAL_PRESENTATION,
      ...ADMIT_AUTHORITY_REFUSALS,
    };
    // The negative control, run inline rather than by editing SQL: inject a
    // synthetic result and prove the same comparison rejects it. Without this,
    // "everything is mapped" could hold because the extractor found nothing.
    const withSynthetic = new Set([...admitVocabulary(), "synthetic_new_refusal"]);
    const unmapped = [...withSynthetic]
      .filter((c) => c !== "admitted")
      .filter((c) => !(c in presentationKeys));
    expect(unmapped).toContain("synthetic_new_refusal");
  });

  it("the adapter routes an unrecognised result to indeterminate, never refused", async () => {
    // Runtime half of the same property. A result the table has never heard of
    // must not become a confident refusal — the practitioner would be told the
    // server said no when it said something we could not read.
    const { __refusalFromServerForTest } = await import(
      "@/lib/waitlist/invite-to-book-adapter"
    );
    expect(__refusalFromServerForTest("synthetic_new_refusal").state).toBe("indeterminate");
    expect(__refusalFromServerForTest(null).state).toBe("indeterminate");
    // ...and a KNOWN one is still a definite refusal, so the above is not
    // simply "everything is indeterminate".
    expect(__refusalFromServerForTest("round_full")).toEqual({
      state: "refused",
      code: "admission_round_full",
    });
    // AND the authority refusals admit_ propagates from resolve_owner are
    // DEFINITE, not indeterminate. Before the supplement these fell through and
    // a flat "you are not the owner" read as "we could not confirm — go and
    // check the waitlist", sending a practitioner after a row that never existed.
    expect(__refusalFromServerForTest("not_owner")).toEqual({
      state: "refused",
      code: "not_owner",
    });
    expect(__refusalFromServerForTest("not_a_member")).toEqual({
      state: "refused",
      code: "not_a_member",
    });

    // THE SUPPLEMENT IS NOT A CATCH-ALL, PROVED BY BEHAVIOUR RATHER THAN BY
    // READING ITS KEYS.
    //
    // An earlier version asserted only `Object.keys(ADMIT_AUTHORITY_REFUSALS)`,
    // which stayed GREEN when the lookup was replaced by "anything in
    // INVITE_TO_BOOK_FAILURES" — the table was still correct, it was simply no
    // longer what the code consulted. Caught by running that mutation.
    //
    // These codes are real members of the general failure union but are NOT in
    // `admit_`'s vocabulary: they belong to release / requeue / expire / remove.
    // If one ever comes back from `admit_`, we have misread the answer, and
    // `indeterminate` is the only honest reading. A widened lookup turns each
    // into a confident refusal and reds here.
    for (const foreign of ["not_removable", "not_requeueable", "already_active"]) {
      expect(
        __refusalFromServerForTest(foreign).state,
        `${foreign} is not an admit_ result and must not become a refusal`,
      ).toBe("indeterminate");
    }
  });
});

// ===========================================================================
describe("B — the invite-to-book adapter binds #683's contract to 0193", () => {
  it("advertises only what it implements atomically", async () => {
    const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");
    const caps = admissionCommandAdapter.capabilities;
    expect(caps.enforcesScope).toBe(true);
    expect(caps.canCancel).toBe(true);
    // 0193 ships ONE compound command. The other three have no atomic
    // equivalent, and the contract says advertising a partial escape is worse
    // than advertising none.
    expect(caps.canResend).toBe(false);
    expect(caps.canReturnToWaitlist).toBe(false);
    expect(caps.canRemove).toBe(false);
  });

  it("exposes no Claim vocabulary to the practitioner surface", () => {
    const src = readFileSync("lib/waitlist/invite-to-book-adapter.ts", "utf8");
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    // The adapter may CALL a claiming command inside admit_, but it must not
    // offer claim as a concept, nor accept round/allowance/authority inputs.
    expect(code).not.toMatch(/\bclaimEntry\b|\bclaim_new_client_waitlist_entry\b/);
    expect(code).not.toMatch(/roundId|round_id|allowanceRemaining|consumptionCount/);
    // Authority is resolved from the session, never accepted.
    expect(code).toContain("getCurrentPractitionerWithStudio");
    expect(code).not.toMatch(/input\.studioId|input\.actorUserId|input\.role/);
  });

  it("converts a windowDays duration in the STUDIO's timezone", async () => {
    const { __windowToDatesForTest } = await import("@/lib/waitlist/invite-to-book-adapter");
    const scope = { serviceId: "s", windowDays: 7, allowedWeekdays: null };
    // 2026-09-11T02:00Z is still 2026-09-10 in Toronto and already 2026-09-11
    // in Auckland. A UTC-only conversion silently shifts the offer by a day.
    const at = new Date("2026-09-11T02:00:00.000Z");
    expect(__windowToDatesForTest(scope, "America/Toronto", at).start).toBe("2026-09-10");
    expect(__windowToDatesForTest(scope, "Pacific/Auckland", at).start).toBe("2026-09-11");
    // Inclusive: 7 days means today plus six.
    const utc = __windowToDatesForTest(scope, "UTC", at);
    expect(utc.start).toBe("2026-09-11");
    expect(utc.end).toBe("2026-09-17");
  });

  it("counts CALENDAR days across DST, not 24-hour blocks", async () => {
    const { __windowToDatesForTest } = await import("@/lib/waitlist/invite-to-book-adapter");

    /** Inclusive count of local calendar dates from start..end. */
    const inclusiveDays = (start: string, end: string) => {
      let n = 1;
      let cursor = start;
      while (cursor < end) {
        const d = new Date(`${cursor}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        cursor = d.toISOString().slice(0, 10);
        n += 1;
      }
      return n;
    };

    // THE INSTANT MUST HUG LOCAL MIDNIGHT, or this control is vacuous.
    //
    // A one-hour offset change only moves a DATE when the local clock is within
    // an hour of midnight. An earlier version of this test used mid-afternoon
    // instants, and restoring the 24-hour arithmetic left it GREEN — the two
    // methods agreed because nothing crossed a date boundary. Caught by running
    // the mutation, and the fix is the times below, not more cases.
    //
    // Direction matters too. Springing forward (offset rises) makes a 24-hour
    // sum drift LATER in local time, so it only overshoots from a LATE local
    // time. Falling back makes it drift EARLIER, so it only undershoots from an
    // EARLY one.
    const cases: Array<{ label: string; tz: string; at: string; start: string }> = [
      // Toronto spring-forward 2026-03-08 (23h). Local 2026-03-05 23:30 EST.
      { label: "toronto-spring", tz: "America/Toronto", at: "2026-03-06T04:30:00.000Z", start: "2026-03-05" },
      // Toronto fall-back 2026-11-01 (25h). Local 2026-10-29 00:30 EDT.
      { label: "toronto-fall", tz: "America/Toronto", at: "2026-10-29T04:30:00.000Z", start: "2026-10-29" },
      // Auckland DST ends 2026-04-05 (25h). Local 2026-04-02 00:30 NZDT.
      { label: "auckland-end", tz: "Pacific/Auckland", at: "2026-04-01T11:30:00.000Z", start: "2026-04-02" },
      // Auckland DST begins 2026-09-27 (23h). Local 2026-09-24 23:30 NZST.
      { label: "auckland-begin", tz: "Pacific/Auckland", at: "2026-09-24T11:30:00.000Z", start: "2026-09-24" },
      // Kiritimati +14:00, the extreme offset and no DST: a PARITY case. Both
      // methods agree here, which is the point — the fix must not move a zone
      // that never transitions.
      { label: "kiritimati", tz: "Pacific/Kiritimati", at: "2026-03-04T10:30:00.000Z", start: "2026-03-05" },
      { label: "utc", tz: "UTC", at: "2026-03-05T23:30:00.000Z", start: "2026-03-05" },
    ];

    for (const N of [1, 7, 14, 30]) {
      for (const c of cases) {
        const { start, end } = __windowToDatesForTest(
          { serviceId: "s", windowDays: N, allowedWeekdays: null },
          c.tz,
          new Date(c.at),
        );
        expect(start, `${c.label} start`).toBe(c.start);
        expect(inclusiveDays(start, end), `${c.label} N=${N}`).toBe(N);
      }
    }
  });

  it("hands the corrected LOCAL dates to the weekday scope evaluator", async () => {
    // The weekday rule is evaluated against the invitation's stored dates, so a
    // start date that drifted by a day would shift which weekdays are offered.
    // Toronto on 2026-03-05 is a Thursday; the window's first date must evaluate
    // as Thursday, not as the UTC day the server happened to be on.
    const { __windowToDatesForTest } = await import("@/lib/waitlist/invite-to-book-adapter");
    const { start } = __windowToDatesForTest(
      { serviceId: "s", windowDays: 7, allowedWeekdays: [4] },
      "America/Toronto",
      // 01:00Z on the 6th is still the 5th in Toronto.
      new Date("2026-03-06T01:00:00.000Z"),
    );
    expect(start).toBe("2026-03-05");
    expect(new Date(`${start}T12:00:00Z`).getUTCDay()).toBe(4);
  });

  it("refuses bad product input — scope, TTL and weekdays — without widening", async () => {
    const { validateInviteInput } = await import("@/lib/waitlist/invite-to-book-adapter");
    const svc = "00000000-0000-0000-0000-000000000002";
    const ok = { serviceId: svc, windowDays: 7, allowedWeekdays: null } as const;
    const entryId = "00000000-0000-0000-0000-000000000001";

    // Unscoped service: refused rather than sent as "any service".
    expect(
      validateInviteInput({ entryId, scope: { ...ok, serviceId: null }, expiresInHours: 72 }),
    ).toBe("scope_not_supported");
    // TTL out of the command's own 1..168: refused, never clamped.
    expect(validateInviteInput({ entryId, scope: ok, expiresInHours: 999 })).toBe("invalid_ttl");
    expect(validateInviteInput({ entryId, scope: ok, expiresInHours: 0 })).toBe("invalid_ttl");
    // Empty weekday array authorises nothing; null means every day.
    expect(
      validateInviteInput({ entryId, scope: { ...ok, allowedWeekdays: [] }, expiresInHours: 72 }),
    ).toBe("invalid_input");
    expect(
      validateInviteInput({ entryId, scope: { ...ok, allowedWeekdays: [7] }, expiresInHours: 72 }),
    ).toBe("invalid_input");
    expect(validateInviteInput({ entryId, scope: { ...ok, windowDays: 0 }, expiresInHours: 72 })).toBe(
      "invalid_input",
    );
    // A well-formed request passes.
    expect(
      validateInviteInput({ entryId, scope: { ...ok, allowedWeekdays: [1, 3] }, expiresInHours: 72 }),
    ).toBeNull();
  });

  it("checks AUTHORITY before input, so an unauthenticated caller learns nothing", async () => {
    // No session in this lane. A malformed input must still come back as the
    // authority refusal, not as a validation hint about the studio's command.
    const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");
    const out = await admissionCommandAdapter.inviteToBook({
      entryId: "00000000-0000-0000-0000-000000000001",
      scope: { serviceId: null, windowDays: 999, allowedWeekdays: [] },
      expiresInHours: 999,
    });
    expect(out.state).not.toBe("committed");
    if (out.state === "refused") {
      expect(out.code).not.toBe("scope_not_supported");
      expect(out.code).not.toBe("invalid_ttl");
      expect(out.code).not.toBe("invalid_input");
    }
  });
});
