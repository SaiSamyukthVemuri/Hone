import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";

// PAY-SETTLE / 0187 — THE SERVICE-VALUE SNAPSHOT IS THE DATABASE'S, NOT THE
// CALLER'S — AND IT MUST AGREE WITH THE RESOLVER THE CARD PATH USES.
//
// quoted_amount_cents used to be a PARAMETER of commands granted to
// `authenticated`, so any practitioner could call PostgREST directly and store
// an invented service value in the column FIN-01A divides by. The parameter is
// gone and the database derives it.
//
// That only helps if the derivation is the SAME law. Two implementations of one
// pricing rule is how a collection rate quietly stops matching what Checkout
// displayed, so every case below runs BOTH: the SQL helper against real rows,
// and the pure TypeScript resolver against the same facts. They are asserted to
// agree, case by case, rather than each being asserted against a hand-written
// expectation that could drift with them.

const created: string[] = [];
afterAll(async () => {
  for (const id of created) {
    await adminQuery(`delete from public.studios where id = $1`, [id]).catch(() => undefined);
  }
  await closePool();
});

const TZ = "America/Toronto";

async function studio(label: string): Promise<SeededStudio> {
  const s = await seedStudio(`qa-${label}-${randomUUID().slice(0, 6)}`);
  created.push(s.studioId);
  await adminQuery(`update public.studios set timezone = $2 where id = $1`, [s.studioId, TZ]);
  return s;
}

/** Studio-local today, read from the database so both sides use one clock. */
async function studioToday(studioId: string): Promise<string> {
  const r = await adminQuery(
    `select to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') d
       from public.studios s where s.id = $1`,
    [studioId],
  );
  return r.rows[0].d as string;
}

async function seedAppointment(
  s: SeededStudio,
  opts: { servicePriceCents: number | null | "none"; serviceName?: string },
): Promise<{ appointmentId: string; serviceName: string | null }> {
  const appointmentId = randomUUID();
  let serviceId: string | null = null;
  let serviceName: string | null = null;
  if (opts.servicePriceCents !== "none") {
    serviceId = randomUUID();
    serviceName = opts.serviceName ?? `Service ${appointmentId.slice(0, 8)}`;
    await adminQuery(
      `insert into public.services (id, studio_id, name, price_cents)
       values ($1,$2,$3,$4)`,
      [serviceId, s.studioId, serviceName, opts.servicePriceCents],
    );
  }
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, service_id, status,
        starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot)
     values ($1,$2,$3,$4,$5,'completed',
        now() - interval '2 hours', now() - interval '1 hour',
        now() - interval '1 hour', 60, 0)`,
    [appointmentId, s.studioId, s.clientId, s.practitionerId, serviceId],
  );
  return { appointmentId, serviceName };
}

async function addPricing(
  s: SeededStudio,
  serviceName: string,
  priceCents: number,
  effectiveFrom: string,
  clientId?: string,
): Promise<void> {
  await adminQuery(
    `insert into public.client_pricing
       (id, studio_id, client_id, service_name, price_cents, effective_from)
     values ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), s.studioId, clientId ?? s.clientId, serviceName, priceCents, effectiveFrom],
  );
}

/** The DB's answer. */
async function dbQuoted(studioId: string, appointmentId: string): Promise<number | null> {
  const r = await adminQuery(
    `select public.appointment_quoted_amount_cents($1,$2) q`,
    [studioId, appointmentId],
  );
  return r.rows[0].q as number | null;
}

/** The resolver's answer, mapped onto the same "one number or nothing" shape. */
async function tsQuoted(
  studioId: string,
  appointmentId: string,
): Promise<number | null> {
  const a = await adminQuery(
    `select a.duration_minutes, a.client_id, s.name, s.price_cents
       from public.appointments a
       left join public.services s on s.id = a.service_id and s.studio_id = a.studio_id
      where a.id = $1 and a.studio_id = $2`,
    [appointmentId, studioId],
  );
  const row = a.rows[0];
  const pricing = await adminQuery(
    `select service_name, price_cents, notes, to_char(effective_from,'YYYY-MM-DD') effective_from
       from public.client_pricing where studio_id=$1 and client_id=$2`,
    [studioId, row.client_id],
  );
  const result = resolveAuthoritativeSessionPaymentAmount({
    service: row.name ? { name: row.name, price_cents: row.price_cents } : null,
    appointmentDurationMinutes: row.duration_minutes,
    customPricing: pricing.rows as never,
    today: await studioToday(studioId),
  });
  if (result.kind === "resolved") return result.amountCents;
  if (result.kind === "free") return 0;
  return null;
}

/** Every case asserts the two agree AND that the shared answer is the expected one. */
async function bothAgree(
  studioId: string,
  appointmentId: string,
  expected: number | null,
): Promise<void> {
  const db = await dbQuoted(studioId, appointmentId);
  const ts = await tsQuoted(studioId, appointmentId);
  expect(db).toBe(ts);
  expect(db).toBe(expected);
}

function isoDaysFromToday(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("the DB snapshot and the pure resolver agree on the price law", () => {
  it("a positive menu price", async () => {
    const s = await studio("menu");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 9000 });
    await bothAgree(s.studioId, appointmentId, 9000);
  });

  it("an explicit $0 menu price is an AUTHORITATIVE zero, not a missing price", async () => {
    const s = await studio("zero");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 0 });
    await bothAgree(s.studioId, appointmentId, 0);
  });

  it("a NULL menu price is unresolved — a configuration gap is never free", async () => {
    const s = await studio("nullprice");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: null });
    await bothAgree(s.studioId, appointmentId, null);
  });

  it("no booked service at all is unresolved", async () => {
    const s = await studio("noservice");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: "none" });
    await bothAgree(s.studioId, appointmentId, null);
  });

  it("a CURRENT positive custom price overrides the menu", async () => {
    const s = await studio("custom");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 7500, isoDaysFromToday(today, -10));
    await bothAgree(s.studioId, appointmentId, 7500);
  });

  it("a custom price overrides even a $0 menu service", async () => {
    const s = await studio("custom-over-zero");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 0 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 5000, isoDaysFromToday(today, -1));
    await bothAgree(s.studioId, appointmentId, 5000);
  });

  it("a FUTURE custom price is ignored — it does not price today's visit", async () => {
    const s = await studio("future");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 100, isoDaysFromToday(today, 5));
    await bothAgree(s.studioId, appointmentId, 9000);
  });

  it("an OLDER custom price loses to a newer effective_from", async () => {
    const s = await studio("newest");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 6000, isoDaysFromToday(today, -30));
    await addPricing(s, serviceName!, 8000, isoDaysFromToday(today, -2));
    await bothAgree(s.studioId, appointmentId, 8000);
  });

  it("equally-current rows that AGREE resolve deterministically", async () => {
    const s = await studio("tie-agree");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    const d = isoDaysFromToday(today, -3);
    await addPricing(s, serviceName!, 7000, d);
    await addPricing(s, serviceName!, 7000, d);
    await bothAgree(s.studioId, appointmentId, 7000);
  });

  it("equally-current rows that DISAGREE resolve to NULL, never by row order", async () => {
    const s = await studio("tie-conflict");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    const d = isoDaysFromToday(today, -3);
    await addPricing(s, serviceName!, 7000, d);
    await addPricing(s, serviceName!, 8000, d);
    await bothAgree(s.studioId, appointmentId, null);
    // Repeated reads never start picking one: it is not a race, it is a refusal.
    for (let i = 0; i < 5; i++) {
      expect(await dbQuoted(s.studioId, appointmentId)).toBeNull();
    }
  });

  it("a zero or negative custom price is 'no custom price recorded', not 'charge nothing'", async () => {
    const s = await studio("zero-custom");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 0, isoDaysFromToday(today, -1));
    await bothAgree(s.studioId, appointmentId, 9000);
  });

  it("service-name matching is normalized (case and surrounding space)", async () => {
    const s = await studio("normalized");
    const { appointmentId } = await seedAppointment(s, {
      servicePriceCents: 9000,
      serviceName: "Laser Full Legs",
    });
    const today = await studioToday(s.studioId);
    await addPricing(s, "  laser FULL legs ", 6500, isoDaysFromToday(today, -1));
    await bothAgree(s.studioId, appointmentId, 6500);
  });

  it("another studio's pricing cannot influence the result", async () => {
    const a = await studio("tenant-a");
    const b = await studio("tenant-b");
    const { appointmentId, serviceName } = await seedAppointment(a, {
      servicePriceCents: 9000,
      serviceName: "Shared Name",
    });
    const today = await studioToday(a.studioId);
    // Same service NAME, same effective date, another tenant entirely.
    await addPricing(b, "Shared Name", 100, isoDaysFromToday(today, -1), b.clientId);
    await bothAgree(a.studioId, appointmentId, 9000);
  });

  it("another CLIENT's pricing in the same studio cannot influence the result", async () => {
    const s = await studio("other-client");
    const other = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Other')`, [
      other,
      s.studioId,
    ]);
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 100, isoDaysFromToday(today, -1), other);
    await bothAgree(s.studioId, appointmentId, 9000);
  });

  it("a cross-studio appointment id resolves to NULL, never to another tenant's price", async () => {
    const a = await studio("x-a");
    const b = await studio("x-b");
    const { appointmentId } = await seedAppointment(b, { servicePriceCents: 9000 });
    expect(await dbQuoted(a.studioId, appointmentId)).toBeNull();
  });
});

describe("a resolved price outside the snapshot's domain is a CLOSED refusal", () => {
  // appointment_settlements.quoted_amount_cents is bounded 0..200000, but
  // services.price_cents and client_pricing.price_cents are bounded only by
  // >= 0. So a studio can legitimately record a $2,500 service, the helper
  // resolves it perfectly well, and the INSERT then trips the CHECK — which
  // surfaced to the practitioner as an authorization failure.
  //
  // NOT CLAMPED to 200000: that would fabricate the service value in the number
  // FIN-01A divides by. NOT nulled: NULL means the price could not be resolved,
  // and this one resolved fine. A closed business result instead, decided
  // BEFORE any write.
  async function settle(s: SeededStudio, appointmentId: string) {
    return asUser(s.userId, async (q) => {
      const r = await q(
        `select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,false)`,
        [s.studioId, appointmentId],
      );
      return r.rows[0] as { result: string };
    });
  }

  const settlementCount = async (studioId: string) =>
    (
      await adminQuery(
        `select count(*)::int n from public.appointment_settlements where studio_id=$1`,
        [studioId],
      )
    ).rows[0].n as number;

  it("exactly 200000 is ACCEPTED and stored", async () => {
    const s = await studio("bound-ok");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 200000 });
    expect((await settle(s, appointmentId)).result).toBe("recorded");
    const row = (
      await adminQuery(
        `select quoted_amount_cents from public.appointment_settlements where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0];
    expect(row.quoted_amount_cents).toBe(200000);
  });

  it("200001 is a closed refusal, with zero rows written", async () => {
    const s = await studio("bound-over-1");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 200001 });
    expect((await settle(s, appointmentId)).result).toBe("invalid_input");
    expect(await settlementCount(s.studioId)).toBe(0);
  });

  it("250000 is a closed refusal, not a CHECK error", async () => {
    const s = await studio("bound-over-2");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 250000 });
    // The point is that this RESOLVES and is then refused in business terms.
    expect(await dbQuoted(s.studioId, appointmentId)).toBe(250000);
    expect((await settle(s, appointmentId)).result).toBe("invalid_input");
    expect(await settlementCount(s.studioId)).toBe(0);
  });

  it("an out-of-range CUSTOM price refuses the same way", async () => {
    const s = await studio("bound-custom");
    const { appointmentId, serviceName } = await seedAppointment(s, { servicePriceCents: 9000 });
    const today = await studioToday(s.studioId);
    await addPricing(s, serviceName!, 300000, isoDaysFromToday(today, -1));
    expect((await settle(s, appointmentId)).result).toBe("invalid_input");
    expect(await settlementCount(s.studioId)).toBe(0);
  });

  it("an out-of-range price does NOT retire a prepared card attempt", async () => {
    // The refusal is decided before retirement, so a practitioner is never left
    // with a cancelled charge AND no settlement.
    const s = await studio("bound-ready");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 250000 });
    const sessionId = randomUUID();
    const attemptId = randomUUID();
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, appointment_id)
       values ($1,$2,$3,$4,'electrolysis',$5)`,
      [sessionId, s.studioId, s.clientId, s.practitionerId, appointmentId],
    );
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, charge_reason, client_id, session_id, appointment_id,
          created_by_practitioner_id, amount_cents, currency, status, stripe_livemode)
       values ($1,$2,'session_payment',$3,$4,$5,$6,4500,'cad','ready',false)`,
      [attemptId, s.studioId, s.clientId, sessionId, appointmentId, s.practitionerId],
    );

    expect((await settle(s, appointmentId)).result).toBe("invalid_input");
    expect(
      (await adminQuery(`select status from public.payment_charge_attempts where id=$1`, [attemptId]))
        .rows[0].status,
    ).toBe("ready");
  });

  it("an explicit $0 is stored, and a missing or ambiguous price is stored as NULL", async () => {
    const zero = await studio("bound-zero");
    const z = await seedAppointment(zero, { servicePriceCents: 0 });
    expect((await settle(zero, z.appointmentId)).result).toBe("recorded");
    expect(
      (await adminQuery(
        `select quoted_amount_cents from public.appointment_settlements where studio_id=$1`,
        [zero.studioId],
      )).rows[0].quoted_amount_cents,
    ).toBe(0);

    const missing = await studio("bound-missing");
    const m = await seedAppointment(missing, { servicePriceCents: null });
    expect((await settle(missing, m.appointmentId)).result).toBe("recorded");
    expect(
      (await adminQuery(
        `select quoted_amount_cents from public.appointment_settlements where studio_id=$1`,
        [missing.studioId],
      )).rows[0].quoted_amount_cents,
    ).toBeNull();

    const amb = await studio("bound-ambiguous");
    const a = await seedAppointment(amb, { servicePriceCents: 9000 });
    const today = await studioToday(amb.studioId);
    const d = isoDaysFromToday(today, -2);
    await addPricing(amb, a.serviceName!, 7000, d);
    await addPricing(amb, a.serviceName!, 8000, d);
    expect((await settle(amb, a.appointmentId)).result).toBe("recorded");
    expect(
      (await adminQuery(
        `select quoted_amount_cents from public.appointment_settlements where studio_id=$1`,
        [amb.studioId],
      )).rows[0].quoted_amount_cents,
    ).toBeNull();
  });

  it("the practitioner's attested amount is untouched by any of this", async () => {
    const s = await studio("bound-amount");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 9000 });
    await settle(s, appointmentId);
    expect(
      (await adminQuery(
        `select amount_cents from public.appointment_settlements where studio_id=$1`,
        [s.studioId],
      )).rows[0].amount_cents,
    ).toBe(4500);
  });
});

describe("the caller has nothing left to forge", () => {
  it("no settlement command exposes a quoted-price parameter", async () => {
    const r = await adminQuery(
      `select p.proname, pg_get_function_identity_arguments(p.oid) args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('record_appointment_settlement','waive_appointment_fee',
                            'supersede_appointment_settlement')`,
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows as Array<{ proname: string; args: string }>) {
      expect(row.args).not.toMatch(/quoted/i);
    }
  });

  it("the derivation helper is callable by nobody", async () => {
    const r = await adminQuery(
      `select coalesce(array_to_string(p.proacl,'|'),'(default)') acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='appointment_quoted_amount_cents'`,
    );
    const acl = r.rows[0].acl as string;
    expect(acl).not.toMatch(/anon|authenticated|service_role/);
  });

  it("the recorded snapshot is the DERIVED value, not the practitioner's amount", async () => {
    const s = await studio("derived");
    const { appointmentId } = await seedAppointment(s, { servicePriceCents: 9000 });
    // The practitioner attests she collected $12 in cash on a $90 service. Both
    // are true, and they are different facts: amount_cents is what happened,
    // quoted_amount_cents is what the service is worth.
    // Through the real authority boundary: the command re-derives the actor
    // from auth.uid(), so an admin connection cannot stand in for one.
    await asUser(s.userId, (q) =>
      q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',1200,null,false)`, [
        s.studioId,
        appointmentId,
      ]),
    );
    const row = (
      await adminQuery(
        `select amount_cents, quoted_amount_cents
           from public.appointment_settlements where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0];
    expect(row.amount_cents).toBe(1200);
    expect(row.quoted_amount_cents).toBe(9000);
  });
});
