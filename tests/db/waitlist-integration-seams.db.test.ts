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
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).not.toBe("scope_not_supported");
      expect(out.code).not.toBe("invalid_ttl");
      expect(out.code).not.toBe("invalid_input");
    }
  });
});
