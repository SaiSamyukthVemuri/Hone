// LOCAL-ONLY synthetic Fett twin SEED (#825 6154587789, persisted per 6156413624 §1–2). Composition-only
// tooling: run through scripts/fett-twin/reset.sh, never against a shared, hosted or other-lane stack.
//
// IDEMPOTENT BY PROOF. validateTwin() (./fett-twin-manifest.ts) decides first:
//   absent   -> seed from scratch;
//   verified -> write nothing, report the facts;
//   refused  -> fail with every mismatch and the recovery instruction (guarded isolated reset).
// A studio that merely shares the slug is never accepted and never overwritten.
//
// AUTHORITIES. Real commands wherever one exists: invitation accept (0141/0218), internal and receptionist
// booking (0220), payment jurisdiction (0214), settlement (0187/0224), machine contract/register/remember/
// capture/retire (0223), email + SMS ledgers (0206/0212/0221), delivery concern (0221). Direct inserts ONLY
// where the app itself inserts directly (studios, practitioners, clients, services, availability, past
// completed visits and their sessions), mirroring tests/db/helpers/fett-fixture.ts, e2e/helpers/seed.ts and
// tests/db/helpers/usd-payment-fixture.ts. Every command's RESULT is checked; ledger states are read back.
//
// SAFETY. Synthetic identities only (@fett-twin.synth.local, 555-01xx). Every studio SMS toggle is false and
// no client has SMS consent, so the app never attempts an SMS. The seed contacts no provider: ledger rows go
// through the ledger commands, not through sending. DATES: past visits are synthetic visit dates; a setup
// capture's recorded_at is the database time it was written (today) and is NOT backdated.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { adminQuery, asUser, closePool, type UserQuery } from "../db/helpers/harness";
import { bindFakeStripeAccount, makeStudioUsd, seedCardOnFile } from "../db/helpers/usd-payment-fixture";
import { setFettCapacityState } from "../db/helpers/fett-fixture";
import {
  recordSetupGroup,
  registerStudioMachine,
  rememberMachine,
  retireStudioMachine,
  type MachineDb,
} from "@/lib/machines/machine-queries";
import { nativeFieldGroups } from "@/lib/machines/charting";
import { activeModes, type MachineProfile } from "@/lib/machines/profile-contract";
import { catalogueForRuntime, SYNTHETIC_DEMO_PROFILE as SYNTH, SYNTHETIC_SINGLE_PROBE } from "@/lib/machines/synthetic-profile";
import { EMAILS, IDS, TWIN, validateTwin } from "./fett-twin-manifest";
import { assertTwinTarget } from "./fett-twin-target";

const report: Array<{ step: string; ok: boolean; detail: string }> = [];
const note = (step: string, ok: boolean, detail = "") => report.push({ step, ok, detail });
const tokenHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

const target = assertTwinTarget();

async function authUser(email: string): Promise<string> {
  const existing = await adminQuery(`select id from auth.users where lower(email) = lower($1)`, [email]);
  if (existing.rows[0]) return existing.rows[0].id as string;
  const res = await fetch(`${target.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`local GoTrue createUser ${email}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function practitioner(studioId: string, email: string, name: string, role: "owner" | "practitioner") {
  const userId = await authUser(email);
  await adminQuery(
    `insert into public.pending_invitations (studio_id, email, role, display_name, status, accepted_at)
     values ($1, $2, $3, $4, 'accepted', now())`,
    [studioId, email, role, name],
  );
  const r = await adminQuery(
    `insert into public.practitioners
       (studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1, $2, $3, $4, $5, true, now(), '2026-05-22', now(), '2026-05-22') returning id`,
    [studioId, userId, name, email, role],
  );
  return { userId, practitionerId: r.rows[0].id as string, email, name };
}

/** Local-time instant on the Nth upcoming weekday (Mon–Fri) in the studio timezone, as SQL. */
function upcoming(nthWeekday: number, hhmm: string): string {
  return `(select ((d + time '${hhmm}') at time zone '${TWIN.timezone}') from (
      select d::date as d from generate_series((now() at time zone '${TWIN.timezone}')::date + 1,
                                               (now() at time zone '${TWIN.timezone}')::date + 21, interval '1 day') d
       where extract(isodow from d) between 1 and 5 order by d offset ${nthWeekday} limit 1) s)`;
}

function pgMachineDb(q: UserQuery): MachineDb {
  const run = async (sql: string, params: unknown[]) => {
    try {
      const r = await q(sql, params);
      return { data: r.rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const names = Object.keys(args);
      const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
      const out = await run(
        `select public.${fn}(${placeholders}) as result`,
        names.map((n) => (n === "p_readings" || n === "p_fields" ? JSON.stringify(args[n]) : args[n])),
      );
      if (out.error) return { data: null, error: out.error };
      return { data: (out.data as Array<{ result: unknown }>)[0]?.result ?? null, error: null };
    },
    from() {
      throw new Error("not used by the seed");
    },
  } as unknown as MachineDb;
}

/**
 * Every SYNTHETIC profile the app itself would offer, taken from the app's own gated runtime catalogue
 * (the same three-way gate the UI uses: exact flag, no deployment signal, loopback Supabase). Real
 * manufacturer profiles are never published or registered here.
 */
function syntheticProfiles(apiUrl: string): MachineProfile[] {
  const gateEnv: NodeJS.ProcessEnv = { ...process.env, HONE_SYNTHETIC_MACHINE_PROFILE: "1", NEXT_PUBLIC_SUPABASE_URL: apiUrl };
  const gated = catalogueForRuntime(gateEnv);
  return gated.filter((p) => p.profileId.startsWith("synthetic:"));
}

/** Deployment-authority publish of a synthetic contract (service_role-only command; idempotent per version). */
async function publishSyntheticContract(profile: MachineProfile): Promise<void> {
  for (const mode of activeModes(profile)) {
    const modeDef = profile.modes.find((m) => m.key === mode.key)!;
    const all = modeDef.fields.concat(modeDef.stages.flatMap((st) => st.fields));
    const fields = nativeFieldGroups(profile, mode).flatMap((g) =>
      g.fields.map((f) => ({
        stage_key: f.stageKey ?? "",
        field_key: f.key,
        native_unit: f.unit || "none",
        decimals: f.decimals,
        quantity: all.find((ff) => ff.key === f.key)!.quantity,
      })),
    );
    if (fields.length === 0) continue;
    await adminQuery(`select public.sync_machine_profile_contract($1, $2, $3, $4, $5, $6::jsonb)`, [
      profile.profileId,
      profile.version,
      mode.key,
      profile.channels?.count ?? null,
      mode.requiresInstalledOption ?? null,
      JSON.stringify(fields),
    ]);
  }
}

/** A past COMPLETED visit: synthetic visit date, plus its session and one block. */
async function pastVisit(studioId: string, practitionerId: string, clientId: string, serviceId: string, daysAgo: number) {
  const appt = await adminQuery(
    `insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
                                      duration_minutes, status, buffer_minutes_snapshot, blocked_ends_at)
     select $1, $2, $3, $4, s, s + interval '60 minutes', 60, 'completed', 0, s + interval '60 minutes'
       from (select ((((now() at time zone '${TWIN.timezone}')::date - $5::int) + time '10:00') at time zone '${TWIN.timezone}') as s) x
     returning id, starts_at`,
    [studioId, practitionerId, clientId, serviceId, daysAgo],
  );
  const sessionId = randomUUID();
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, appointment_id, started_at)
     values ($1, $2, $3, $4, 'electrolysis', $5, $6)`,
    [sessionId, studioId, clientId, practitionerId, appt.rows[0].id, appt.rows[0].starts_at],
  );
  await adminQuery(`insert into public.session_blocks (id, studio_id, session_id, block_name) values ($1, $2, $3, 'Upper lip')`, [
    blockId,
    studioId,
    sessionId,
  ]);
  return { appointmentId: appt.rows[0].id as string, sessionId, blockId };
}

const READING = (current: number) => [
  { stageKey: null, fieldKey: "current", value: { kind: "value" as const, value: current }, nativeUnit: "µA", decimals: 0, observationSource: "practitioner-entered" as const },
  { stageKey: null, fieldKey: "duration", value: { kind: "value" as const, value: 300.5 }, nativeUnit: "s", decimals: 1, observationSource: "practitioner-entered" as const },
];

afterAll(async () => {
  console.log("\n[fett-twin seed report]");
  for (const r of report) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.detail ? `  — ${r.detail}` : ""}`);
  await closePool();
});

it("seeds (or proves) the persistent synthetic Fett twin", { timeout: 600_000 }, async () => {
  const verdict = await validateTwin();
  if (verdict.state === "verified") {
    note("idempotency: existing twin VERIFIED against the manifest; nothing written", true, JSON.stringify(verdict.facts));
    return;
  }
  if (verdict.state === "refused") {
    note("idempotency: existing studio REFUSED (not this twin, or incomplete)", false, `${verdict.problems.join("; ")}. ${verdict.recovery}`);
    throw new Error(`fett-twin refused: ${verdict.problems.join("; ")}`);
  }

  // ---- A. Studio, people, jurisdiction, services, availability, capacity ----------------------------
  const studioId = IDS.studio;
  await adminQuery(
    `insert into public.studios (id, name, owner_email, slug, timezone, buffer_minutes, default_appointment_duration_minutes,
                                 send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders)
     values ($1, $2, $3, $4, $5, 0, 60, false, false, false)`,
    [studioId, TWIN.name, EMAILS.owner, TWIN.slug, TWIN.timezone],
  );
  const owner = await practitioner(studioId, EMAILS.owner, "SYNTH-FETT Owner", "owner");
  const treating: Array<Awaited<ReturnType<typeof practitioner>>> = [];
  for (let i = 1; i <= TWIN.treatingCount; i += 1) {
    treating.push(await practitioner(studioId, EMAILS.treating(i), `SYNTH-FETT Electrologist ${i}`, "practitioner"));
  }
  note("A1 studio + owner + 5 treating practitioners (login-capable)", true, studioId);

  const ownerRef = { studioId, userId: owner.userId, practitionerId: owner.practitionerId, clientId: "" };
  await makeStudioUsd(ownerRef as never);
  const jur = (await adminQuery(`select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id = $1`, [studioId])).rows[0];
  note("A2 payment jurisdiction US/USD via set_studio_payment_jurisdiction", jur?.payment_country === "US" && jur?.payment_currency === "usd", JSON.stringify(jur ?? null));

  await adminQuery(
    `insert into public.services (id, studio_id, name, modality, default_duration_minutes, price_cents, active)
     values ($1, $3, 'SYNTH-FETT Electrolysis consultation', 'consultation', 30, 0, true),
            ($2, $3, 'SYNTH-FETT Electrolysis treatment', 'electrolysis', 60, 15000, true)`,
    [IDS.consult, IDS.treatment, studioId],
  );
  for (const p of [owner, ...treating]) {
    for (const s of [IDS.consult, IDS.treatment]) {
      // A trigger already links new services to practitioners; this only fills any gap.
      await adminQuery(
        `insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`,
        [studioId, s, p.practitionerId],
      );
    }
  }
  await adminQuery(
    `insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time)
     select $1, d, d between 1 and 5, '09:00', '17:00' from generate_series(0, 6) d`,
    [studioId],
  );
  await setFettCapacityState(studioId, "live");
  note("A3 services (USD-priced treatment $150), eligibility, Mon–Fri 09–17 LA, capacity LIVE", true);

  // ---- B. Receptionist via the real invitation path; support operator account ----------------------
  await adminQuery(
    `insert into public.pending_invitations (studio_id, email, invited_by, role, display_name, status)
     values ($1, $2, $3, 'receptionist', 'SYNTH-FETT Front Desk', 'pending')`,
    [studioId, EMAILS.desk, owner.practitionerId],
  );
  const deskUserId = await authUser(EMAILS.desk);
  const accepted = (await adminQuery(`select public.admin_accept_pending_invitation($1) as r`, [deskUserId])).rows[0].r;
  note("B1 receptionist invited + accepted (admin_accept_pending_invitation)", accepted?.status === "linked" && accepted?.role === "receptionist", JSON.stringify(accepted));
  await authUser(EMAILS.operator);
  note("B2 synthetic support operator account (admin only via the app's ADMIN_EMAILS allowlist)", true, EMAILS.operator);

  // ---- C. Clients (deterministic ids) --------------------------------------------------------------
  for (let i = 1; i <= TWIN.clientCount; i += 1) {
    await adminQuery(`insert into public.clients (id, studio_id, name, email, phone) values ($1, $2, $3, $4, $5)`, [
      IDS.client(i),
      studioId,
      `SYNTH-FETT Client ${String(i).padStart(2, "0")}`,
      `client-${i}${TWIN.domain}`,
      `+1555010${String(i).padStart(4, "0")}`,
    ]);
  }
  const c = (i: number) => IDS.client(i);
  note("C1 12 synthetic clients (no SMS consent)", true);

  // ---- D. Upcoming bookings ------------------------------------------------------------------------
  const book = async (targetPractitioner: string, client: string, whenSql: string, service: string = IDS.treatment) => {
    // A same-practitioner overlap is refused by the exclusion constraint itself, which RAISES.
    try {
      const r = await adminQuery(
        `select * from public.create_internal_appointment_v2($1, $2, $3, $4, $5, ${whenSql}, $6, null, null, false)`,
        [studioId, owner.practitionerId, targetPractitioner, client, service, tokenHash()],
      );
      return r.rows[0] as { result: string; appointment_id: string | null };
    } catch (e) {
      return { result: `refused: ${(e as { constraint?: string }).constraint ?? (e as Error).message.slice(0, 60)}`, appointment_id: null };
    }
  };
  const p1 = await book(treating[0]!.practitionerId, c(1), upcoming(0, "10:00"));
  const p2 = await book(treating[1]!.practitionerId, c(2), upcoming(0, "10:00"));
  note("D1 two practitioners hold the SAME instant (capacity LIVE)", p1.result === "created" && p2.result === "created", `${p1.result} / ${p2.result}`);
  const clash = await book(treating[0]!.practitionerId, c(3), upcoming(0, "10:00"));
  note("D2 same practitioner, same instant is REFUSED", clash.result !== "created", clash.result);
  const others: Array<{ result: string; appointment_id: string | null }> = [];
  for (let i = 0; i < 8; i += 1) {
    others.push(await book(treating[i % 5]!.practitionerId, c(4 + i), upcoming(1 + (i % 4), i % 2 ? "13:00" : "11:00")));
  }
  note("D3 further upcoming bookings across practitioners", others.every((o) => o.result === "created"), others.map((o) => o.result).join(","));
  const deskBook = await asUser(deskUserId, (q) =>
    q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, ${upcoming(2, "15:00")})`, [studioId, treating[2]!.practitionerId, c(12), IDS.consult]),
  );
  note("D4 receptionist books through receptionist_create_appointment", deskBook.rows[0]?.result === "created", deskBook.rows[0]?.result);

  // ---- E. Machines ----------------------------------------------------------------------------------
  const profiles = syntheticProfiles(target.apiUrl);
  for (const p of profiles) await publishSyntheticContract(p);
  const asDb = <T,>(userId: string, fn: (db: MachineDb) => Promise<T>) => asUser(userId, (q) => fn(pgMachineDb(q)));
  const unit = await asDb(owner.userId, (db) =>
    registerStudioMachine(db, { studioId, profileId: SYNTH.profileId, profileVersion: SYNTH.version, displayName: "Room 1 demo" }),
  );
  const oldUnit = await asDb(owner.userId, (db) =>
    registerStudioMachine(db, { studioId, profileId: SYNTH.profileId, profileVersion: SYNTH.version, displayName: "Room 2 (retired)" }),
  );
  // A DIFFERENT synthetic model (own mode, overlapping `current` key at a different unit/precision, a unique
  // field, no channels) so a machine switch in the charting form is a falsifiable proof, not a decoration.
  const singleUnit = await asDb(owner.userId, (db) =>
    registerStudioMachine(db, {
      studioId,
      profileId: SYNTHETIC_SINGLE_PROBE.profileId,
      profileVersion: SYNTHETIC_SINGLE_PROBE.version,
      displayName: "Room 3 single-probe demo",
    }),
  );
  note(
    "E1 synthetic contracts published (gated runtime catalogue) + 3 units registered on 2 models",
    unit.ok && oldUnit.ok && singleUnit.ok && profiles.length >= 2,
    `${profiles.map((p) => `${p.profileId} v${p.version}`).join(", ")}${singleUnit.ok ? "" : ` | ${singleUnit.error}`}`,
  );
  const e1 = treating[0]!;
  const mode = activeModes(SYNTH)[0]!.key;
  const remembered = unit.ok ? await asDb(e1.userId, (db) => rememberMachine(db, { studioId, machineId: unit.value, modeKey: mode })) : null;
  note("E2 electrologist 1 remembers 'Room 1 demo'", !!remembered?.ok, remembered && !remembered.ok ? remembered.error : "");
  const older = await pastVisit(studioId, e1.practitionerId, c(1), IDS.treatment, 28);
  const recent = await pastVisit(studioId, e1.practitionerId, c(1), IDS.treatment, 7);
  if (unit.ok && oldUnit.ok) {
    const h = await asDb(e1.userId, (db) => recordSetupGroup(db, { blockId: older.blockId, sessionId: older.sessionId, clientId: c(1), machineId: oldUnit.value, modeKey: mode, groupKey: null, newGroupRef: "g1", channels: [], readings: READING(110) }));
    const r1 = await asDb(e1.userId, (db) => recordSetupGroup(db, { blockId: recent.blockId, sessionId: recent.sessionId, clientId: c(1), machineId: unit.value, modeKey: mode, groupKey: null, newGroupRef: "g1", channels: [], readings: READING(135) }));
    // #860's final 0223 MINTS group keys server-side: revise the recent visit's
    // group by the key the database issued for its first capture.
    const minted = (
      await adminQuery(
        `select group_key from public.treatment_setup_captures where session_block_id = $1 order by revision desc limit 1`,
        [recent.blockId],
      )
    ).rows[0]?.group_key as string | undefined;
    const r2 = await asDb(e1.userId, (db) => recordSetupGroup(db, { blockId: recent.blockId, sessionId: recent.sessionId, clientId: c(1), machineId: unit.value, modeKey: mode, groupKey: minted ?? null, newGroupRef: minted ? null : "g1", channels: [], readings: READING(180) }));
    note("E3 captures: older visit on Room 2; recent visit revisions 1 (135 µA) then 2 (180 µA)", h.ok && r1.ok && r2.ok, [h, r1, r2].map((x) => (x.ok ? "ok" : x.error)).join(" | "));
    const retired = await asDb(owner.userId, (db) => retireStudioMachine(db, oldUnit.value));
    note("E4 'Room 2 (retired)' retired; its history stays named", retired.ok, retired.ok ? "" : retired.error);
  }
  const nextVisit = await book(e1.practitionerId, c(1), upcoming(3, "09:00"));
  note("E5 same-client next visit booked", nextVisit.result === "created", nextVisit.result);

  // ---- F. USD fake-Stripe layer and settlement ----------------------------------------------------
  const payRef = { studioId, userId: owner.userId, practitionerId: e1.practitionerId, clientId: c(5) };
  const account = await bindFakeStripeAccount(payRef as never, { reportedCountry: "US" });
  await seedCardOnFile(payRef as never, account);
  note("F1 fake Stripe TEST account (US) bound + card on file for client 05", true, String((account as { accountId?: string }).accountId ?? ""));
  const payable = await pastVisit(studioId, e1.practitionerId, c(5), IDS.treatment, 1);
  note("F2 completed USD visit ready to charge (fake Stripe) — client 05", true, payable.sessionId);
  // Two OLDER payable visits for the restart scenario (scripts/fett-twin/pay-step.mjs): charge one, restart
  // the server, charge the other on the new process, refund the first. The walkthrough keeps the newest.
  const restartA = await pastVisit(studioId, e1.practitionerId, c(5), IDS.treatment, 4);
  const restartB = await pastVisit(studioId, e1.practitionerId, c(5), IDS.treatment, 5);
  note("F2b two older USD visits for the restart scenario — client 05", !!restartA.sessionId && !!restartB.sessionId, `${restartA.sessionId} ${restartB.sessionId}`);
  const otherWay = await pastVisit(studioId, e1.practitionerId, c(6), IDS.treatment, 2);
  const settled = await asUser(e1.userId, (q) =>
    q(`select * from public.record_appointment_settlement($1, $2, 'paid_other_external', 15000, 'Zelle (synthetic)', false)`, [studioId, otherWay.appointmentId]),
  ).catch((e) => ({ rows: [{ result: `error: ${(e as Error).message}` }] }));
  note("F3 'Paid another way' (paid_other_external) recorded", settled.rows[0]?.result === "recorded", settled.rows[0]?.result);
  const eTransfer = await asUser(e1.userId, (q) =>
    q(`select * from public.record_appointment_settlement($1, $2, 'paid_e_transfer', 15000, null, false)`, [studioId, payable.appointmentId]),
  )
    .then((r) => r.rows[0]?.result)
    .catch((e) => `refused: ${(e as Error).message.slice(0, 80)}`);
  note("F4 e-Transfer REFUSED for a US studio (0224)", String(eTransfer).startsWith("refused"), String(eTransfer));

  // ---- G. Delivery: email accepted / refused, SMS refused, owner concern ---------------------------
  const appts = [p1.appointment_id, p2.appointment_id, others[0]?.appointment_id].filter(Boolean) as string[];
  const deliv: string[] = [];
  const okId = (await adminQuery(`select public.begin_appointment_email_message($1, $2, 'appointment_confirmation') as id`, [studioId, appts[0]])).rows[0].id;
  deliv.push(`email accepted→${(await adminQuery(`select public.settle_email_message($1, 'accepted', $2, null, null) as r`, [okId, randomUUID()])).rows[0].r}`);
  const badId = (await adminQuery(`select public.begin_appointment_email_message($1, $2, 'appointment_confirmation') as id`, [studioId, appts[1]])).rows[0].id;
  deliv.push(`email refused→${(await adminQuery(`select public.settle_email_message($1, 'refused', null, 'synthetic_provider_refusal', null) as r`, [badId])).rows[0].r}`);
  const smsId = (await adminQuery(`select public.begin_appointment_sms_message($1, $2, 'appointment_confirmation') as id`, [studioId, appts[2]])).rows[0].id;
  deliv.push(`sms refused→${smsId ? (await adminQuery(`select public.settle_sms_message($1, 'refused', null, 30007, null) as r`, [smsId])).rows[0].r : "begin returned null"}`);
  const L = (
    await adminQuery(
      `select (select string_agg(status, ',' order by status) from public.email_outbound_messages where studio_id = $1) as email,
              (select string_agg(status, ',' order by status) from public.sms_outbound_messages where studio_id = $1) as sms,
              (select count(*)::int from public.delivery_incidents where studio_id = $1) as incidents`,
      [studioId],
    )
  ).rows[0];
  note(
    "G1 delivery ledger states (read back from the ledger)",
    L.email === "accepted,refused" && L.sms === "refused" && L.incidents >= 2 && !deliv.some((d) => d.includes("invalid_input")),
    `${deliv.join(", ")}; ledger email=${L.email} sms=${L.sms} incidents=${L.incidents}`,
  );
  const concern = await asUser(owner.userId, (q) => q(`select * from public.report_delivery_concern($1, $2, 'email', 'appointment_confirmation')`, [studioId, appts[0]]))
    .then((r) => r.rows[0]?.result)
    .catch((e) => `error: ${(e as Error).message.slice(0, 90)}`);
  note("G2 owner reports a delivery concern", !String(concern).startsWith("error"), String(concern));

  // ---- H. Canadian regression studio --------------------------------------------------------------
  await adminQuery(
    `insert into public.studios (id, name, owner_email, slug, timezone, buffer_minutes, send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders)
     values ($1, $2, $3, $4, 'America/Toronto', 0, false, false, false)`,
    [IDS.studioCa, TWIN.nameCa, EMAILS.caOwner, TWIN.slugCa],
  );
  const caOwner = await practitioner(IDS.studioCa, EMAILS.caOwner, "SYNTH-FETT CA Owner", "owner");
  await adminQuery(
    `insert into public.services (id, studio_id, name, modality, default_duration_minutes, price_cents, active) values ($1, $2, 'SYNTH-FETT CA treatment', 'electrolysis', 60, 12000, true)`,
    [IDS.caService, IDS.studioCa],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1, $2, 'SYNTH-FETT CA Client', $3)`, [IDS.caClient, IDS.studioCa, `ca-client${TWIN.domain}`]);
  const caAppt = (
    await adminQuery(
      `insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, buffer_minutes_snapshot, blocked_ends_at)
       values ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day' + interval '60 minutes', 60, 'completed', 0, now() - interval '1 day' + interval '60 minutes') returning id`,
      [IDS.studioCa, caOwner.practitionerId, IDS.caClient, IDS.caService],
    )
  ).rows[0].id as string;
  const caSettle = await asUser(caOwner.userId, (q) => q(`select * from public.record_appointment_settlement($1, $2, 'paid_e_transfer', 12000, null, false)`, [IDS.studioCa, caAppt]))
    .then((r) => r.rows[0]?.result)
    .catch((e) => `error: ${(e as Error).message.slice(0, 90)}`);
  note("H1 Canadian studio: default CA/cad, e-Transfer ACCEPTED", caSettle === "recorded", String(caSettle));

  // ---- Final proof: the twin now VALIDATES against its own manifest --------------------------------
  const after = await validateTwin();
  note("Z manifest validation after seeding", after.state === "verified", after.state === "refused" ? after.problems.join("; ") : after.state);

  expect(report.filter((r) => !r.ok).map((r) => r.step)).toEqual([]);
});
