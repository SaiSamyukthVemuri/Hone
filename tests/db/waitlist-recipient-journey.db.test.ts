import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

// ===========================================================================
// WAIT INTEGRATION-01 — the recipient journey, across REAL component boundaries
// ===========================================================================
//
// Accepted inputs:
//   #681 / 0192   7fde53d0fd46d77adb6b6f052a6ddb54fc6b2022
//   #682 / B2     d7915c380f4c606dcb5f0d071b454b7c394e821b
//   #686 / B3     11dd5cc41fa171f7328a969dfa81d9040955b2d9
//   #680 delivery c8ea9e5d1ab711a13f60aa7d09383ae5a5709da4  (seam vendored verbatim)
//
// THE ONLY FAKE IS THE EXTERNAL EMAIL PROVIDER. Not the challenge, not the
// capability, not an RPC result, not the delivery decision, not the renderer,
// not the idempotency key, not the identity command, not the booking engine.
// `next/headers` is substituted, but with a REAL cookie jar that records the
// flags it is given, so the HttpOnly boundary is asserted rather than assumed.
//
// TWO THINGS CHANGED SINCE THE PREVIOUS RUN, and both are re-proved here rather
// than assumed:
//   * 0192 gained `resolve_waitlist_invitation_recipient_identity`, so B3 no
//     longer reads `new_client_waitlist_entries` directly — which 0185 forbids.
//     That was the previous run's blocker; booking is now reachable.
//   * a capability the DATABASE rejects must no longer render as proven. The
//     cookie still has a valid HMAC and a future signed expiry, so only the
//     database can settle it.

type SentMail = {
  payload: { from: string; to: string; subject: string; html: string; text: string; replyTo?: string };
  idempotencyKey?: string;
};
type CookieWrite = { name: string; value: string; options: Record<string, unknown> };

const hoisted = vi.hoisted(() => ({
  sends: [] as SentMail[],
  writes: [] as CookieWrite[],
  jar: new Map<string, string>(),
  refuse: { on: false },
  requestHeaders: new Headers({ "x-forwarded-for": "203.0.113.11" }),
}));

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => null,
  resend: {
    emails: {
      send: async (payload: SentMail["payload"], options?: { idempotencyKey?: string }) => {
        hoisted.sends.push({ payload, idempotencyKey: options?.idempotencyKey });
        if (hoisted.refuse.on) {
          return { data: null, error: { name: "validation_error", message: "refused" } };
        }
        return { data: { id: `msg_${hoisted.sends.length}` }, error: null };
      },
    },
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      hoisted.jar.has(name) ? { name, value: hoisted.jar.get(name) } : undefined,
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      hoisted.writes.push({ name, value, options: options ?? {} });
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
  process.env.APPOINTMENT_SIGNING_SECRET = "wait-integration-journey-secret";
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.APPOINTMENT_SIGNING_SECRET = savedEnv.secret;
  await closePool();
});

beforeEach(() => {
  hoisted.sends.length = 0;
  hoisted.writes.length = 0;
  hoisted.jar.clear();
  hoisted.refuse.on = false;
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CAPABILITY_COOKIE = "wl_proof_capability";

type Offer = {
  studio: SeededStudio;
  slug: string;
  serviceId: string;
  entryId: string;
  invitationId: string;
  token: string;
  email: string;
  name: string;
  phone: string | null;
};

type OfferOpts = {
  /** `extract(dow)`, 0 = Sunday. NULL means every day. */
  weekdays?: number[] | null;
  startOffset?: number;
  endOffset?: number;
  /** false seeds a non-consultation service (out-of-scope-service control). */
  consultation?: boolean;
  /** null seeds the ordinary "phone optional" entry. */
  phone?: string | null;
};

/**
 * A studio that is genuinely PUBLICLY BOOKABLE and whose service a NEW CLIENT
 * may book. `seedStudio` sets none of this, and `isBookableByNewClient` also
 * demands an ACTIVE CONSULTATION — a bare seed yields an empty proven view for
 * reasons unrelated to proof, hiding the failures this file exists to catch.
 */
async function makeBookableStudio(label: string, consultation: boolean) {
  const studio = await seedStudio(label);
  const slug = `wl-j3-${studio.studioId.slice(0, 8)}`;
  await adminQuery(
    `update public.studios
        set slug = $2, timezone = 'UTC', postcare_contact_email = $3
      where id = $1`,
    [studio.studioId, slug, `contact-${studio.studioId.slice(0, 8)}@harness.local`],
  );
  const svc = await adminQuery(
    `insert into public.services
       (studio_id, name, default_duration_minutes, price_cents, active, modality)
     values ($1, $2, 60, 10000, true, $3) returning id`,
    [
      studio.studioId,
      consultation ? `Consultation ${label}` : `Treatment ${label}`,
      consultation ? "consultation" : "treatment",
    ],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '09:00', '17:00', null from generate_series(0, 6) g
     on conflict (studio_id, day_of_week, practitioner_id) do update
        set is_open = true, open_time = '09:00', close_time = '17:00'`,
    [studio.studioId],
  );
  return { studio, slug, serviceId: svc.rows[0].id as string };
}

async function seedOffer(label: string, opts: OfferOpts = {}): Promise<Offer> {
  const consultation = opts.consultation ?? true;
  const phone = opts.phone === undefined ? "+15550000123" : opts.phone;
  const { studio, slug, serviceId } = await makeBookableStudio(label, consultation);
  // THROUGH 0193'S OWN COMMAND, not an insert.
  //
  // 0192 keyed this table on `studio_id`, one row per studio, so the fixture
  // upserted it directly. 0193 made rounds a DURABLE LEDGER with an open/close
  // lifecycle, server-owned stamps and a one-open-round rule, and the old
  // `on conflict (studio_id)` no longer matches any constraint. Using the
  // command means the fixture cannot drift from the authority again.
  //
  // ANTI-VACUITY: a fixture that silently failed to open a round would make
  // every admission assertion pass for the wrong reason.
  const round = await adminQuery(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
    [studio.studioId, studio.userId, 10],
  );
  expect(round.rows[0].result, "the fixture must actually open a round").toBe("opened");
  const email = `p-${label}-${studio.studioId.slice(0, 8)}@harness.local`;
  const name = `Prospect ${label}`;
  const joined = await adminQuery(
    `select result, entry_id from public.join_new_client_waitlist($1, $2, $3, $4)`,
    [studio.studioId, name, email, phone],
  );
  const entryId = joined.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1, $2, $3)`, [
    studio.studioId,
    entryId,
    studio.userId,
  ]);
  const issued = await adminQuery(
    `select result, raw_token, invitation_id
       from public.issue_scoped_new_client_waitlist_invitation(
              $1, $2, $3, $4,
              current_date + $5::int, current_date + $6::int, $7::smallint[], 72)`,
    [
      studio.studioId, entryId, studio.userId, serviceId,
      opts.startOffset ?? 0, opts.endOffset ?? 13, opts.weekdays ?? null,
    ],
  );
  expect(issued.rows[0].result).toBe("issued");
  return {
    studio, slug, serviceId, entryId, email, name, phone,
    token: issued.rows[0].raw_token as string,
    invitationId: issued.rows[0].invitation_id as string,
  };
}

/** The code AS THE RECIPIENT READS IT — parsed from the delivered body only. */
function codeFromDeliveredEmail(text: string): string {
  const m = /Your confirmation code is ([^\s]+)/.exec(text);
  expect(m, "the delivered email must state a confirmation code").not.toBeNull();
  return (m as RegExpExecArray)[1];
}

const actions = () => import("@/app/invitation/[token]/actions");

async function proveWithDeliveredCode(offer: Offer) {
  const { requestInvitationProofAction, submitInvitationProofAction } = await actions();
  const requested = await requestInvitationProofAction(offer.token);
  if (requested.kind !== "proof" || requested.stage.kind !== "sent") {
    throw new Error(`expected a sent proof stage, got ${JSON.stringify(requested)}`);
  }
  const code = codeFromDeliveredEmail(hoisted.sends[hoisted.sends.length - 1].payload.text);
  const submitted = await submitInvitationProofAction(offer.token, code, {
    maskedContact: requested.stage.maskedContact,
    expiresAt: requested.stage.expiresAt,
  });
  return { requested, submitted, code };
}

async function invitationRow(invitationId: string) {
  const r = await adminQuery(
    `select redeemed_at, declined_at, released_at,
            proof_challenge_hash, proof_capability_hash
       from public.new_client_waitlist_invitations where id = $1`,
    [invitationId],
  );
  return r.rows[0];
}

/** Call the identity RPC exactly as the application does. */
async function identityRpc(token: string, capability: string | null) {
  const r = await adminQuery(
    `select result, name, email, phone
       from public.resolve_waitlist_invitation_recipient_identity($1, $2)`,
    [token, capability],
  );
  return r.rows[0] as {
    result: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
}

const rawCapabilityFromJar = () =>
  (hoisted.jar.get(CAPABILITY_COOKIE) as string | undefined)?.split(".")[0] ?? null;

/**
 * The PROOF emails only.
 *
 * A completed booking legitimately sends its own confirmation through the same
 * transport, so a bare `sends.length` would count two different things and the
 * "exactly one code was sent" claim would drift the moment booking started
 * working — which is exactly what happened.
 */
const proofSends = () =>
  hoisted.sends.filter((m) => m.payload.subject.includes("confirmation code"));

const apptCount = async (studioId: string) =>
  (await adminQuery(`select id from public.appointments where studio_id = $1`, [studioId])).rows
    .length;

// ===========================================================================
describe("WAIT INTEGRATION-01 — recipient journey, accepted stack", () => {
  // -------------------------------------------------------------------------
  it("mints, delivers, proves, scopes, resolves identity and BOOKS", async () => {
    const offer = await seedOffer("journey");
    const { loadInvitationAction, bookInvitationSlotAction } = await actions();

    // --- 2/3/4. real bearer resolve + REAL 0192 begin-proof -----------------
    const { beginRecipientProof } = await import("@/lib/booking/waitlist-invitation");
    const probe = await seedOffer("authority");
    const begun = await beginRecipientProof(probe.token, 15);
    expect(begun.kind).toBe("challenge_issued");
    if (begun.kind !== "challenge_issued") throw new Error("expected a challenge");
    expect(begun.proofChallengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(begun.rawChallenge).toBeTruthy();
    expect(begun.deliveryContact).toBe(probe.email);
    expect(begun.expiresAt).toBeTruthy();
    expect(begun.issuedAt).toBeTruthy();
    // AUTHORITATIVE issued_at: both ends come from the same post-lock clock, so
    // the window is exactly the requested TTL. A derived value could not fail
    // this; an application clock would drift off it.
    expect(Date.parse(begun.expiresAt) - Date.parse(begun.issuedAt)).toBe(15 * 60_000);

    // --- 1/5/6/7. real delivery path, fake transport only -------------------
    const { requested, submitted, code } = await proveWithDeliveredCode(offer);
    expect(proofSends()).toHaveLength(1);
    const sent = proofSends()[0];
    expect(sent.payload.to).toBe(offer.email);
    expect(sent.payload.from).toContain("Harness journey");
    expect(sent.payload.replyTo).toBeTruthy();
    expect(sent.idempotencyKey).toBeTruthy();
    expect(sent.idempotencyKey).not.toContain(code);
    expect(sent.payload.text).toContain("expires in 15 minutes");
    expect(requested.stage.kind === "sent" && requested.stage.maskedContact).not.toBe(offer.email);

    // --- 8/9. the delivered code completed REAL proof -----------------------
    expect(submitted.kind).toBe("offer");
    if (submitted.kind !== "offer") throw new Error(`got ${submitted.kind}`);
    const afterProof = await invitationRow(offer.invitationId);
    expect(afterProof.proof_capability_hash).toBeTruthy();
    expect(afterProof.proof_challenge_hash).toBeNull();

    // --- 10. capability crosses ONLY the HttpOnly cookie boundary -----------
    const capWrite = hoisted.writes.filter((w) => w.name === CAPABILITY_COOKIE && w.value !== "");
    expect(capWrite).toHaveLength(1);
    expect(capWrite[0].options.httpOnly).toBe(true);
    expect(capWrite[0].options.sameSite).toBe("lax");
    expect(capWrite[0].options.path).toBe("/invitation");
    const rawCapability = rawCapabilityFromJar() as string;
    expect(JSON.stringify(submitted)).not.toContain(rawCapability);
    expect(JSON.stringify(submitted)).not.toContain(code);

    // --- 11/12. the real scoped-slot path -----------------------------------
    const loaded = await loadInvitationAction(offer.token);
    expect(loaded.kind).toBe("offer");
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    const slots = loaded.days.flatMap((d) => [...d.slots]);
    expect(slots.length).toBeGreaterThan(0);
    const scope = await adminQuery(
      `select scope_start_date::text s, scope_end_date::text e
         from public.new_client_waitlist_invitations where id = $1`,
      [offer.invitationId],
    );
    const { s, e } = scope.rows[0] as { s: string; e: string };
    for (const day of loaded.days) {
      expect(day.date >= s).toBe(true);
      expect(day.date <= e).toBe(true);
    }
    expect(loaded.presentation.serviceName).toContain("Consultation");

    // --- 13/14. the identity RPC returns the EXACT stored identity ----------
    const ident = await identityRpc(offer.token, rawCapability);
    expect(ident.result).toBe("resolved");
    expect(ident.name).toBe(offer.name);
    expect(ident.email).toBe(offer.email);
    expect(ident.phone).toBe(offer.phone);

    // --- 15/16. one real booking through the SHARED engine ------------------
    const chosen = slots[0];
    const booked = await bookInvitationSlotAction(offer.token, chosen.start);
    expect(booked.kind).toBe("booked");

    const appts = await adminQuery(
      `select id, starts_at from public.appointments
        where studio_id = $1 and service_id = $2`,
      [offer.studio.studioId, offer.serviceId],
    );
    expect(appts.rows).toHaveLength(1);

    // The STORED identity is what reached the engine — proved on the row the
    // booking created, not on the arguments the test passed.
    const client = await adminQuery(
      `select c.name, c.email, c.phone
         from public.clients c
         join public.appointments a on a.client_id = c.id
        where a.id = $1`,
      [appts.rows[0].id],
    );
    expect(client.rows[0].email).toBe(offer.email);
    expect(client.rows[0].name).toBe(offer.name);
    expect(client.rows[0].phone).toBe(offer.phone);

    // Consumed exactly once.
    expect(await invitationRow(offer.invitationId).then((r) => r.redeemed_at)).not.toBeNull();
    const again = await bookInvitationSlotAction(offer.token, chosen.start);
    expect(again.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(1);

    // Exactly ONE proof code was ever put on the wire for this recipient.
    expect(proofSends()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it("scope is INDEPENDENTLY rechecked at mutation time", async () => {
    // Mondays only. The screen offers Mondays; a Tuesday inside the date window
    // is posted directly, as a modified client would.
    //
    // NON-VACUOUS BY CONSTRUCTION: the second half books an IN-SCOPE slot on the
    // same fixture and succeeds, so "booking always fails" cannot produce this.
    const offer = await seedOffer("recheck", { weekdays: [1], startOffset: 1, endOffset: 20 });
    const { bookInvitationSlotAction, loadInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);

    const loaded = await loadInvitationAction(offer.token);
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    for (const day of loaded.days) {
      expect(new Date(`${day.date}T12:00:00Z`).getUTCDay()).toBe(1);
    }
    for (const slot of loaded.days.flatMap((d) => [...d.slots])) {
      expect(new Date(slot.start).getUTCDay()).toBe(1);
    }
    const offered = loaded.days[0].slots[0].start;
    const tuesday = new Date(Date.parse(offered) + 24 * 3600_000).toISOString();
    expect(new Date(tuesday).getUTCDay()).toBe(2);

    const refused = await bookInvitationSlotAction(offer.token, tuesday);
    expect(refused.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(0);

    // THE POSITIVE HALF — same fixture, an in-scope Monday, must book.
    const ok = await bookInvitationSlotAction(offer.token, offered);
    expect(ok.kind).toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  it("an out-of-scope DATE is refused at the mutation", async () => {
    const offer = await seedOffer("date", { startOffset: 1, endOffset: 3 });
    const { bookInvitationSlotAction, loadInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);
    const loaded = await loadInvitationAction(offer.token);
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    expect(loaded.days.length).toBeGreaterThan(0);
    expect(loaded.days.length).toBeLessThanOrEqual(3);

    const beyond = new Date(Date.now() + 30 * 86_400_000);
    beyond.setUTCHours(10, 0, 0, 0);
    const out = await bookInvitationSlotAction(offer.token, beyond.toISOString());
    expect(out.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(0);

    // Positive half, so the refusal above is about SCOPE and not about booking
    // being broken.
    const ok = await bookInvitationSlotAction(offer.token, loaded.days[0].slots[0].start);
    expect(ok.kind).toBe("booked");
  });

  // -------------------------------------------------------------------------
  it("the waitlist FEATURE FLAG does not gate an issued invitation, and scope still binds", async () => {
    // `isNewClientWaitlistEnabled` is an env slug allowlist, UNSET here — i.e.
    // the studio's waitlist is disabled after the invitation was issued. The
    // invitation is its own authority, so an in-scope booking must still
    // complete AND an out-of-scope one must still be refused. If scope were
    // enforced by the feature flag, one of these two would be wrong.
    expect(process.env.NEW_CLIENT_WAITLIST_SLUGS ?? "").toBe("");
    const offer = await seedOffer("flagoff", { weekdays: [3], startOffset: 1, endOffset: 20 });
    const { bookInvitationSlotAction, loadInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);
    const loaded = await loadInvitationAction(offer.token);
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    const wednesday = loaded.days[0].slots[0].start;
    expect(new Date(wednesday).getUTCDay()).toBe(3);

    const off = await bookInvitationSlotAction(
      offer.token,
      new Date(Date.parse(wednesday) + 24 * 3600_000).toISOString(),
    );
    expect(off.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(0);

    const ok = await bookInvitationSlotAction(offer.token, wednesday);
    expect(ok.kind).toBe("booked");
  });

  // -------------------------------------------------------------------------
  it("a nullable phone is carried as null and asked for, not invented", async () => {
    const offer = await seedOffer("nophone", { phone: null });
    const { bookInvitationSlotAction, loadInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);
    const cap = rawCapabilityFromJar() as string;

    const ident = await identityRpc(offer.token, cap);
    expect(ident.result).toBe("resolved");
    expect(ident.phone).toBeNull();

    const loaded = await loadInvitationAction(offer.token);
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    const slot = loaded.days[0].slots[0].start;

    // No stored phone and none typed: refused BEFORE the engine.
    const asked = await bookInvitationSlotAction(offer.token, slot);
    expect(asked.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(0);

    // A typed number is read ONLY because the entry has none.
    const ok = await bookInvitationSlotAction(offer.token, slot, "+15550009999");
    expect(ok.kind).toBe("booked");
  });

  // -------------------------------------------------------------------------
  it("a proven capability declines; the invitation closes through DB authority", async () => {
    const offer = await seedOffer("decline");
    const { declineInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);
    const declined = await declineInvitationAction(offer.token);
    expect(declined.kind).toBe("declined");
    const row = await invitationRow(offer.invitationId);
    expect(row.declined_at).not.toBeNull();
    expect(row.redeemed_at).toBeNull();
  });

  // =========================================================================
  // A. DB-STALE CAPABILITY — cookie valid, database says no
  // =========================================================================
  it("A. a DB-rejected capability does not render proven, and recovers", async () => {
    const offer = await seedOffer("stalecap");
    const { loadInvitationAction, bookInvitationSlotAction, requestInvitationProofAction } =
      await actions();
    await proveWithDeliveredCode(offer);

    // The cookie as a SECOND TAB would still hold it.
    const cookie = hoisted.jar.get(CAPABILITY_COOKIE) as string;
    expect(cookie).toBeTruthy();
    const [cap, expiresAtMs] = cookie.split(".");
    // A FUTURE signed expiry — one of the two things the cookie can prove on its
    // own. Only the database knows it is dead.
    expect(Number(expiresAtMs)).toBeGreaterThan(Date.now());

    // Requesting a new code invalidates the outstanding capability at the DB.
    await requestInvitationProofAction(offer.token);
    expect(await invitationRow(offer.invitationId).then((r) => r.proof_capability_hash)).toBeNull();

    // The second tab presents the old cookie.
    hoisted.jar.set(CAPABILITY_COOKIE, cookie);
    hoisted.writes.length = 0;

    // The DATABASE agrees it is dead.
    expect((await identityRpc(offer.token, cap)).result).not.toBe("resolved");

    // RENDER PATH: not proven, proof required, lapse notice, cookie cleared.
    const view = await loadInvitationAction(offer.token);
    expect(view.kind).toBe("proof");
    if (view.kind !== "proof") throw new Error("expected the proof screen");
    expect(view.stage.kind).toBe("required");
    expect(view.notice).toBe("proof_lapsed");
    expect(hoisted.writes.some((w) => w.name === CAPABILITY_COOKIE && w.value === "")).toBe(true);
    expect(hoisted.jar.has(CAPABILITY_COOKIE)).toBe(false);

    // BOOK PATH: same recovery, engine never reached, nothing created or consumed.
    hoisted.jar.set(CAPABILITY_COOKIE, cookie);
    const booked = await bookInvitationSlotAction(
      offer.token,
      new Date(Date.now() + 86_400_000).toISOString(),
    );
    expect(booked.kind).toBe("proof");
    if (booked.kind === "proof") expect(booked.notice).toBe("proof_lapsed");
    expect(await apptCount(offer.studio.studioId)).toBe(0);
    expect(await invitationRow(offer.invitationId).then((r) => r.redeemed_at)).toBeNull();
  });

  // =========================================================================
  // B. IDENTITY RPC AUTHORITY
  // =========================================================================
  it("B. the identity RPC resolves for nobody but a live proven capability", async () => {
    const mine = await seedOffer("ident-a");
    const theirs = await seedOffer("ident-b");

    // bearer only -> no identity
    expect((await identityRpc(mine.token, null)).result).not.toBe("resolved");
    // wrong capability -> no identity
    expect((await identityRpc(mine.token, "f".repeat(64))).result).not.toBe("resolved");

    await proveWithDeliveredCode(theirs);
    const theirCap = rawCapabilityFromJar() as string;
    // cross-invitation capability -> no identity
    expect((await identityRpc(mine.token, theirCap)).result).not.toBe("resolved");
    // ...and it DOES resolve for its own invitation, so the refusals above are
    // about binding, not about the command being inert.
    expect((await identityRpc(theirs.token, theirCap)).result).toBe("resolved");

    // expired capability -> no identity, and no partial row
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set proof_capability_expires_at = now() - interval '1 minute' where id = $1`,
      [theirs.invitationId],
    );
    const expired = await identityRpc(theirs.token, theirCap);
    expect(expired.result).not.toBe("resolved");
    expect(expired.name).toBeNull();
    expect(expired.email).toBeNull();
    expect(expired.phone).toBeNull();

    // stale (replaced) capability -> no identity
    const fresh = await seedOffer("ident-c");
    await proveWithDeliveredCode(fresh);
    const freshCap = rawCapabilityFromJar() as string;
    const { requestInvitationProofAction } = await actions();
    await requestInvitationProofAction(fresh.token);
    expect((await identityRpc(fresh.token, freshCap)).result).not.toBe("resolved");
  });

  // -------------------------------------------------------------------------
  it("B. a NON-PROOF identity failure is not dressed up as a lapsed proof", async () => {
    // An invitation that closes under the recipient is not a proof problem. The
    // screen must NOT claim their proof lapsed.
    const offer = await seedOffer("notproof");
    const { bookInvitationSlotAction, loadInvitationAction } = await actions();
    await proveWithDeliveredCode(offer);
    const loaded = await loadInvitationAction(offer.token);
    if (loaded.kind !== "offer") throw new Error("expected the proven offer");
    const slot = loaded.days[0].slots[0].start;

    await adminQuery(
      `update public.new_client_waitlist_invitations set released_at = now() where id = $1`,
      [offer.invitationId],
    );
    const out = await bookInvitationSlotAction(offer.token, slot);
    if (out.kind === "proof") expect(out.notice).not.toBe("proof_lapsed");
    expect(out.kind).not.toBe("booked");
    expect(await apptCount(offer.studio.studioId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  it("B. service_role still has NO direct read of the entries table", async () => {
    // 0185's revoke is the reason the RPC exists. If anyone grants it back, the
    // narrow command stops being the only path and this reds immediately.
    const priv = await adminQuery(
      `select has_table_privilege('service_role','public.new_client_waitlist_entries','SELECT') tbl,
              has_column_privilege('service_role','public.new_client_waitlist_entries','email','SELECT') col`,
    );
    expect(priv.rows[0].tbl).toBe(false);
    expect(priv.rows[0].col).toBe(false);

    // And the recipient surface contains no direct read of it IN CODE.
    //
    // Comment lines are stripped first, deliberately: the file explains at
    // length what the old table read was and why it went, and a naive substring
    // check matches that prose and reds on a correct file. A guard that cannot
    // tell code from its own changelog is worse than none.
    const src = readFileSync("app/invitation/[token]/actions.ts", "utf8");
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain('.from("new_client_waitlist_entries")');
    expect(code).toContain("resolve_waitlist_invitation_recipient_identity");
  });

  // =========================================================================
  // Remaining negative controls
  // =========================================================================
  it("bearer alone cannot book and cannot decline", async () => {
    const offer = await seedOffer("bearer");
    const { bookInvitationSlotAction, declineInvitationAction, loadInvitationAction } =
      await actions();
    expect((await loadInvitationAction(offer.token)).kind).toBe("proof");
    const book = await bookInvitationSlotAction(
      offer.token, new Date(Date.now() + 86_400_000).toISOString(),
    );
    expect(book.kind).not.toBe("booked");
    expect((await declineInvitationAction(offer.token)).kind).not.toBe("declined");
    const row = await invitationRow(offer.invitationId);
    expect(row.redeemed_at).toBeNull();
    expect(row.declined_at).toBeNull();
    expect(await apptCount(offer.studio.studioId)).toBe(0);
  });

  it("a wrong code is refused, and the real one still works after it", async () => {
    const offer = await seedOffer("wrongcode");
    const { requestInvitationProofAction, submitInvitationProofAction } = await actions();
    const requested = await requestInvitationProofAction(offer.token);
    if (requested.kind !== "proof" || requested.stage.kind !== "sent") {
      throw new Error("expected a sent stage");
    }
    const real = codeFromDeliveredEmail(hoisted.sends[0].payload.text);
    const wrong = real === "000000" ? "111111" : "000000";
    const prev = {
      maskedContact: requested.stage.maskedContact,
      expiresAt: requested.stage.expiresAt,
    };
    expect((await submitInvitationProofAction(offer.token, wrong, prev)).kind).toBe("proof");
    expect(await invitationRow(offer.invitationId).then((r) => r.proof_capability_hash)).toBeNull();
    expect((await submitInvitationProofAction(offer.token, real, prev)).kind).toBe("offer");
  });

  it("an EXPIRED challenge cannot be exchanged", async () => {
    const offer = await seedOffer("expired");
    const { requestInvitationProofAction, submitInvitationProofAction } = await actions();
    const requested = await requestInvitationProofAction(offer.token);
    if (requested.kind !== "proof" || requested.stage.kind !== "sent") {
      throw new Error("expected a sent stage");
    }
    const code = codeFromDeliveredEmail(hoisted.sends[0].payload.text);
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set proof_challenge_expires_at = now() - interval '1 minute' where id = $1`,
      [offer.invitationId],
    );
    const out = await submitInvitationProofAction(offer.token, code, {
      maskedContact: requested.stage.maskedContact,
      expiresAt: requested.stage.expiresAt,
    });
    expect(out.kind).toBe("proof");
    expect(await invitationRow(offer.invitationId).then((r) => r.proof_capability_hash)).toBeNull();
  });

  it("a capability minted for ANOTHER invitation authorises nothing here", async () => {
    const mine = await seedOffer("cross-a");
    const theirs = await seedOffer("cross-b");
    const { bookInvitationSlotAction, declineInvitationAction } = await actions();
    await proveWithDeliveredCode(theirs);
    expect(hoisted.jar.get(CAPABILITY_COOKIE)).toBeTruthy();
    const book = await bookInvitationSlotAction(
      mine.token, new Date(Date.now() + 86_400_000).toISOString(),
    );
    expect(book.kind).not.toBe("booked");
    expect((await declineInvitationAction(mine.token)).kind).not.toBe("declined");
    const row = await invitationRow(mine.invitationId);
    expect(row.redeemed_at).toBeNull();
    expect(row.declined_at).toBeNull();
  });

  it("an out-of-scope SERVICE closes the offer BEFORE proof is even attempted", async () => {
    const offer = await seedOffer("svc", { consultation: false });
    const { requestInvitationProofAction, loadInvitationAction } = await actions();
    expect((await loadInvitationAction(offer.token)).kind).toBe("closed");
    const requested = await requestInvitationProofAction(offer.token);
    expect(requested.kind).toBe("closed");
    if (requested.kind === "closed") expect(requested.reason).toBe("unsupported_offer");
    expect(hoisted.sends).toHaveLength(0);
    expect(await invitationRow(offer.invitationId).then((r) => r.proof_challenge_hash)).toBeNull();
  });

  it("DELIVERY REFUSED IS NEVER REPORTED AS DELIVERED", async () => {
    const offer = await seedOffer("refused");
    const { requestInvitationProofAction } = await actions();
    hoisted.refuse.on = true;
    const out = await requestInvitationProofAction(offer.token);
    expect(out.kind).toBe("proof");
    if (out.kind !== "proof") throw new Error("expected the proof screen");
    expect(out.stage.kind).not.toBe("sent");
    expect(out.stage.kind).toBe("unavailable");
    expect(hoisted.sends.length).toBeGreaterThan(0);
  });

  it("MALFORMED delivery timing is refused before the provider is reached", async () => {
    const { sendWaitlistRecipientProofEmail } = await import("@/lib/waitlist/delivery/send");
    const studio = { id: "00000000-0000-0000-0000-000000000001", name: "Timing" };
    const base = Date.parse("2026-09-09T12:00:00.000Z");
    const before = hoisted.sends.length;
    const overlong = await sendWaitlistRecipientProofEmail({
      studio,
      invitationId: "00000000-0000-0000-0000-000000000002",
      challengeId: "00000000-0000-0000-0000-000000000003",
      recipientEmail: "timing@harness.local",
      code: "abcdef",
      issuedAt: new Date(base),
      expiresAt: new Date(base + 120 * 60_000),
      action: "book",
      now: new Date(base + 1_000),
    });
    expect(overlong.disposition.delivered).toBe("no");
    const inverted = await sendWaitlistRecipientProofEmail({
      studio,
      invitationId: "00000000-0000-0000-0000-000000000002",
      challengeId: "00000000-0000-0000-0000-000000000004",
      recipientEmail: "timing@harness.local",
      code: "abcdef",
      issuedAt: new Date(base),
      expiresAt: new Date(base - 60_000),
      action: "book",
      now: new Date(base + 1_000),
    });
    expect(inverted.disposition.delivered).toBe("no");
    expect(hoisted.sends.length).toBe(before);
  });
});
