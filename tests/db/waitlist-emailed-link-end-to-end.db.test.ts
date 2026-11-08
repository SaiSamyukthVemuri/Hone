import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

// ===========================================================================
// The EMAILED invitation link and the EMAILED code, end to end
// ===========================================================================
//
// Existing tests prove the parts: the database stores sha256(raw token) as the
// token hash, one source-pinned builder spends the raw token into
// `<origin>/invitation/<token>`, and the proof code parsed from a delivered email
// completes real proof. Nothing joined them. This file does, on ONE invitation:
//
//   real adapter (`admissionCommandAdapter.inviteToBook`) -> real admit RPC ->
//   real email composition -> captured provider payload ->
//   the token parsed from the delivered link (text AND html) ->
//   sha256 of it equals the stored token_hash of the invitation that send created ->
//   the code parsed from the delivered code email -> real proof -> real booking.
//
// THE ONLY FAKES: the external email provider; `next/headers` (with a real cookie
// jar, as in waitlist-recipient-journey); the practitioner SESSION lookup (there
// is no browser here, so the owner's session is the one input that has to be
// supplied); and `after` (there is no request scope to defer into). The admit
// command, the delivery policy, the renderer, the proof challenge, the identity
// command and the booking engine are all real.

type SentMail = {
  payload: { from: string; to: string; subject: string; html: string; text: string; replyTo?: string };
  idempotencyKey?: string;
};

const hoisted = vi.hoisted(() => ({
  sends: [] as SentMail[],
  jar: new Map<string, string>(),
  requestHeaders: new Headers({ "x-forwarded-for": "203.0.113.21" }),
  session: null as null | {
    practitioner: { role: string; user_id: string };
    studio: { id: string; name: string; timezone: string; postcare_contact_email: string };
  },
}));

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => null,
  resend: {
    emails: {
      send: async (payload: SentMail["payload"], options?: { idempotencyKey?: string }) => {
        hoisted.sends.push({ payload, idempotencyKey: options?.idempotencyKey });
        return { data: { id: `msg_${hoisted.sends.length}` }, error: null };
      },
    },
  },
}));

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

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));

vi.mock("@/lib/supabase/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/queries")>()),
  getCurrentPractitionerWithStudio: async () => {
    if (!hoisted.session) throw new Error("no session");
    return hoisted.session;
  },
}));

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ORIGIN = "https://hone-link-proof.test";
const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  secret: process.env.APPOINTMENT_SIGNING_SECRET,
  origin: process.env.NEXT_PUBLIC_APP_ORIGIN,
};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.APPOINTMENT_SIGNING_SECRET = "wait-emailed-link-secret";
  process.env.NEXT_PUBLIC_APP_ORIGIN = ORIGIN;
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.APPOINTMENT_SIGNING_SECRET = savedEnv.secret;
  process.env.NEXT_PUBLIC_APP_ORIGIN = savedEnv.origin;
  await closePool();
});

beforeEach(() => {
  hoisted.sends.length = 0;
  hoisted.jar.clear();
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedProspect(label: string) {
  const studio = await seedStudio(label);
  const slug = `wl-link-${studio.studioId.slice(0, 8)}`;
  await adminQuery(
    `update public.studios set slug = $2, timezone = 'UTC', postcare_contact_email = $3 where id = $1`,
    [studio.studioId, slug, `contact-${studio.studioId.slice(0, 8)}@harness.local`],
  );
  const svc = await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
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
    `select result, entry_id from public.join_new_client_waitlist($1, $2, $3, $4)`,
    [studio.studioId, `Prospect ${label}`, email, "+15550000321"],
  );
  const entryId = joined.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1, $2, $3)`, [
    studio.studioId,
    entryId,
    studio.userId,
  ]);
  hoisted.session = {
    practitioner: { role: "owner", user_id: studio.userId },
    studio: {
      id: studio.studioId,
      name: `Studio ${label}`,
      timezone: "UTC",
      postcare_contact_email: `contact-${studio.studioId.slice(0, 8)}@harness.local`,
    },
  };
  return { studio, entryId, serviceId: svc.rows[0].id as string, email };
}

/** Send the invitation through the REAL adapter and return what was DELIVERED. */
async function sendInvitation(p: Awaited<ReturnType<typeof seedProspect>>) {
  const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");
  const outcome = await admissionCommandAdapter.inviteToBook({
    entryId: p.entryId,
    scope: { serviceId: p.serviceId, windowDays: 7, allowedWeekdays: null },
  });
  expect(outcome.state, JSON.stringify(outcome)).toBe("committed");
  const invitationMails = hoisted.sends.filter((m) => /\/invitation\//.test(m.payload.text));
  expect(invitationMails, "exactly one email carries the invitation link").toHaveLength(1);
  return { outcome, mail: invitationMails[0] };
}

/** Every `<origin>/invitation/<token>` URL in a body, tokens only. */
function linkTokens(body: string): string[] {
  return [...body.matchAll(/https:\/\/hone-link-proof\.test\/invitation\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

function codeFromDeliveredEmail(text: string): string {
  const m = /Your confirmation code is ([^\s]+)/.exec(text);
  expect(m, "the delivered email must state a confirmation code").not.toBeNull();
  return (m as RegExpExecArray)[1];
}

const actions = () => import("@/app/invitation/[token]/actions");

describe("the emailed link and the emailed code, end to end", () => {
  it("the token in the delivered link hashes to the stored token_hash of the invitation that send created, and the emailed code then books", async () => {
    const p = await seedProspect("link-e2e");
    const { mail } = await sendInvitation(p);

    // (1) The link, in the text AND the html, carries one and the same token.
    const inText = linkTokens(mail.payload.text);
    const inHtml = linkTokens(mail.payload.html);
    expect(inText, "one link in the text body").toHaveLength(1);
    expect(inHtml.length, "at least one link in the html body").toBeGreaterThan(0);
    for (const t of inHtml) expect(t).toBe(inText[0]);
    const token = inText[0];
    expect(mail.payload.to).toBe(p.email);

    // (2) sha256(that token) is the stored token_hash of THE invitation this send created.
    const stored = await adminQuery(
      `select id, token_hash from public.new_client_waitlist_invitations where entry_id = $1`,
      [p.entryId],
    );
    expect(stored.rows, "this send created exactly one invitation").toHaveLength(1);
    expect(stored.rows[0].token_hash).toBe(sha256(token));
    expect(stored.rows[0].token_hash).not.toBe(token);

    // (3) The emailed code, taken from the delivered code email, proves the recipient.
    const { requestInvitationProofAction, submitInvitationProofAction, loadInvitationAction, bookInvitationSlotAction } =
      await actions();
    const requested = await requestInvitationProofAction(token);
    if (requested.kind !== "proof" || requested.stage.kind !== "sent") {
      throw new Error(`expected a sent proof stage, got ${JSON.stringify(requested)}`);
    }
    const proofMails = hoisted.sends.filter((m) => m.payload.subject.includes("confirmation code"));
    expect(proofMails).toHaveLength(1);
    expect(proofMails[0].payload.to).toBe(p.email);
    const code = codeFromDeliveredEmail(proofMails[0].payload.text);
    const submitted = await submitInvitationProofAction(token, code, {
      maskedContact: requested.stage.maskedContact,
      expiresAt: requested.stage.expiresAt,
    });
    expect(submitted.kind).toBe("offer");

    // (4) Then a real booking through the real engine, on the invitation the email named.
    const loaded = await loadInvitationAction(token);
    if (loaded.kind !== "offer") throw new Error(`expected the proven offer, got ${loaded.kind}`);
    const slots = loaded.days.flatMap((d) => [...d.slots]);
    expect(slots.length).toBeGreaterThan(0);
    const booked = await bookInvitationSlotAction(token, slots[0].start);
    expect(booked.kind).toBe("booked");
    const after = await adminQuery(
      `select i.redeemed_at, e.status
         from public.new_client_waitlist_invitations i
         join public.new_client_waitlist_entries e on e.id = i.entry_id
        where i.id = $1`,
      [stored.rows[0].id],
    );
    expect(after.rows[0].redeemed_at).not.toBeNull();
    expect(after.rows[0].status).toBe("converted");
  });

  it("NEGATIVE CONTROL: the emailed token corrupted by one character is refused, sends no code and books nothing", async () => {
    const p = await seedProspect("link-neg");
    const { mail } = await sendInvitation(p);
    const token = linkTokens(mail.payload.text)[0];
    expect(token).toBeTruthy();
    // One character different, same length and alphabet.
    const last = token[token.length - 1];
    const corrupt = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(corrupt).not.toBe(token);
    // The corrupt value cannot be the stored hash's preimage.
    const stored = await adminQuery(
      `select token_hash from public.new_client_waitlist_invitations where entry_id = $1`,
      [p.entryId],
    );
    expect(sha256(corrupt)).not.toBe(stored.rows[0].token_hash);

    const before = hoisted.sends.length;
    const { requestInvitationProofAction, loadInvitationAction, bookInvitationSlotAction } = await actions();
    const requested = await requestInvitationProofAction(corrupt);
    expect(requested.kind === "proof" && requested.stage.kind === "sent").toBe(false);
    expect(hoisted.sends.length, "no code email may be sent for a token that is not the invitation's").toBe(before);
    const loaded = await loadInvitationAction(corrupt);
    expect(loaded.kind).not.toBe("offer");
    const booked = await bookInvitationSlotAction(corrupt, new Date(Date.now() + 2 * 86_400_000).toISOString());
    expect(booked.kind).not.toBe("booked");
    const appts = await adminQuery(`select id from public.appointments where studio_id = $1`, [p.studio.studioId]);
    expect(appts.rows).toHaveLength(0);
    // The real invitation is untouched and still unredeemed.
    const row = await adminQuery(
      `select redeemed_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [p.entryId],
    );
    expect(row.rows[0].redeemed_at).toBeNull();
  });
});
