import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// HON-7 — REPRODUCTION: the invitation is redeemed BEFORE the appointment commits
// ===========================================================================
//
// WHAT THIS PINS. The application redeems an invitation in its own transaction
// (`redeem_new_client_waitlist_invitation_verified`) and only afterwards asks
// `create_waitlist_public_appointment` to book. Two invitees offered the same
// time therefore both redeem; the loser's booking is refused, and the loser is
// left holding a SPENT invitation and an entry still `invited`, with no
// appointment and no way back: release answers `already_redeemed`.
//
// This is a CHARACTERIZATION of the defect on the current chain (0195, 0200). It
// passes today. The migration that fixes it (0313, one command that redeems only
// on a successful insert) must INVERT the final block, so the repair is visible
// as a change to this file rather than a new file that hides the old behaviour.
// ===========================================================================

const BOOK = `select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`;

afterAll(async () => {
  await closePool();
});

// Per-run salt: the cancellation hash is unique across the whole database, so a
// fixed seed collides with another suite or a re-run.
const tokenHash = (seed: string): string => {
  const salted = `${seed}-${randomUUID()}`;
  return Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(salted.charCodeAt(i % salted.length) + i) % 16]).join("");
};

type Fixture = { studioId: string; userId: string; serviceId: string };

async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`hon7-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function legalSlot(f: Fixture): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length > 0) return cands[0].c;
  }
  throw new Error("no legal slot");
}

/** The REAL chain, as the app drives it: admit -> proof -> redeem. */
async function redeemedEntry(f: Fixture, label: string): Promise<{ entryId: string; email: string }> {
  const email = `h7-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  const b = await q<any>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await q<any>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
  const r = await q<any>(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [a[0].raw_token, c[0].raw_capability],
  );
  expect(r[0].result).toBe("redeemed");
  return { entryId: r[0].entry_id as string, email };
}

async function bookingClient(f: Fixture, email: string): Promise<string> {
  const r = await q<any>(
    `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
    [f.studioId, email],
  );
  return r[0].client_id as string;
}

describe("HON-7 repro: a lost slot burns the invitation (current chain)", () => {
  it("the loser of a contested time is left redeemed, unbooked and unreleasable", async () => {
    const f = await fixture("loser");
    const slot = await legalSlot(f);

    // Both invitees redeem first, exactly as the app does before it books.
    const a = await redeemedEntry(f, "a");
    const b = await redeemedEntry(f, "b");
    const clientA = await bookingClient(f, a.email);
    const clientB = await bookingClient(f, b.email);

    const winner = await q<any>(BOOK, [f.studioId, clientA, f.serviceId, slot, tokenHash("wa"), a.entryId]);
    expect(winner[0].result).toBe("created_and_converted");

    // The loser asks for the SAME time. The command refuses; nothing is written.
    const apptsBefore = await q<{ n: number }>(
      `select count(*)::int as n from public.appointments where studio_id=$1`, [f.studioId],
    );
    const loser = await q<any>(BOOK, [f.studioId, clientB, f.serviceId, slot, tokenHash("lb"), b.entryId]);
    expect(loser[0].appointment_id).toBeNull();
    expect(loser[0].result).not.toMatch(/^created/);
    const apptsAfter = await q<{ n: number }>(
      `select count(*)::int as n from public.appointments where studio_id=$1`, [f.studioId],
    );
    expect(apptsAfter[0].n).toBe(apptsBefore[0].n);

    // THE DEFECT, stated as state. The invitation is spent and the entry is still
    // `invited`: there is no appointment and no durable record of why.
    const inv = await q<{ redeemed_at: string | null }>(
      `select redeemed_at from public.new_client_waitlist_invitations where entry_id=$1`, [b.entryId],
    );
    expect(inv[0].redeemed_at).not.toBeNull();
    const entry = await q<{ status: string }>(
      `select status from public.new_client_waitlist_entries where id=$1`, [b.entryId],
    );
    expect(entry[0].status).toBe("invited");

    // And the way back that exists today is closed: release refuses a redeemed
    // invitation, so the offer cannot be reissued.
    const rel = await q<{ r: string }>(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, b.entryId, f.userId],
    );
    expect(rel[0].r).toBe("already_redeemed");
  });
});
