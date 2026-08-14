import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";

// PR #260: appointment cancel/reschedule tokens are hashed at rest
// (migration 0090). PR #264 (migration 0091) closed the deploy window and
// DROPPED the legacy raw appointments.cancellation_token column, the
// deploy-window hashing trigger, and the dual-match `OR cancellation_token`
// branches in the RPCs. These tests prove the security-critical invariants
// against the real local Postgres after 0091:
//
//   * The TS lookup hash (hashAppointmentToken) and the SQL digest produce
//     the SAME value, so a URL token looked up by the app matches a row.
//   * New rows are hash-only, there is no raw column at rest (the raw
//     column no longer exists: an INSERT referencing it errors 42703).
//   * The cancel + reschedule RPCs match by HASH ONLY; a raw token no longer
//     resolves (the deploy-window tolerance is gone).
//   * Already-emitted raw links still resolve because the app HASHES the URL
//     token before lookup and 0090 backfilled every row's hash (proven via
//     the TS-hash == SQL-digest agreement + the hash-match cancel test).
//   * The format CHECK and partial unique on the hash hold.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("appt-token-hash");
  await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [
    s.studioId,
  ]);
});

afterAll(async () => {
  await closePool();
});

// Each appointment gets its own far-future day so the per-studio
// double-booking exclusion constraint never collides across tests, and
// the cancel/reschedule "starts_at > now()" guards always hold. nextSlot
// also serves as a free target for reschedules.
let slotDay = 0;
function nextSlot(): { start: string; end: string } {
  slotDay += 1;
  const day = String(slotDay).padStart(2, "0");
  // Spread across months/days; slotDay stays well under 27 for this suite.
  return {
    start: `2031-03-${day}T10:00:00Z`,
    end: `2031-03-${day}T11:00:00Z`,
  };
}

function insertHashOnly(token: string) {
  const id = randomUUID();
  const { start, end } = nextSlot();
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status,
        cancellation_token_hash)
     values ($1, $2, $3, $4, $5, 60, 0, $5, 'confirmed', $6)
     returning id`,
    [id, s.studioId, s.clientId, start, end, hashAppointmentToken(token)],
  ).then((r) => r.rows[0].id as string);
}

// B6 / 0175: two tests exercising the LEGACY `reschedule_appointment` v1 were
// retired here when that RPC was dropped after a zero-caller census. Their
// property, hash-only matching, raw tokens refused, is not lost: it is
// covered more strongly against the successor in
// tests/db/public-reschedule-command.db.test.ts, which proves a wrong token
// hash collapses to the same code as an unknown id, refuses a token belonging
// to a DIFFERENT appointment, and refuses a malformed successor hash. That
// duplication was verified before removing these.
describe("appointment token hash-at-rest (migration 0090 + 0091 raw drop)", () => {
  it("TS hash and SQL digest agree (lookup matches storage)", async () => {
    const raw = generateAppointmentToken();
    const tsHash = hashAppointmentToken(raw);
    // node crypto cross-check of the helper itself.
    expect(tsHash).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(tsHash).toMatch(/^[a-f0-9]{64}$/);
    // SQL digest (the backfill expression 0090 used) must equal it, so an
    // already-emitted raw link still hashes to the backfilled stored hash.
    const r = await adminQuery(
      `select encode(extensions.digest($1, 'sha256'), 'hex') as h`,
      [raw],
    );
    expect(r.rows[0].h).toBe(tsHash);
  });

  it("the raw cancellation_token column no longer exists (0091 drop)", async () => {
    const { start, end } = nextSlot();
    await expect(
      adminQuery(
        `insert into public.appointments
           (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
            buffer_minutes_snapshot, blocked_ends_at, status, cancellation_token)
         values ($1, $2, $3, $4, $5, 60, 0, $5, 'confirmed', 'some-raw-token')`,
        [randomUUID(), s.studioId, s.clientId, start, end],
      ),
    ).rejects.toMatchObject({ code: "42703" }); // undefined_column
  });

  it("stores hash-only rows (no raw token at rest)", async () => {
    const raw = generateAppointmentToken();
    const id = await insertHashOnly(raw);
    const r = await adminQuery(
      `select cancellation_token_hash from public.appointments where id = $1`,
      [id],
    );
    expect(r.rows[0].cancellation_token_hash).toBe(hashAppointmentToken(raw));
  });

  it("rejects a malformed hash (format CHECK)", async () => {
    const { start, end } = nextSlot();
    await expect(
      adminQuery(
        `insert into public.appointments
           (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
            buffer_minutes_snapshot, blocked_ends_at, status,
            cancellation_token_hash)
         values ($1, $2, $3, $4, $5, 60, 0, $5, 'confirmed', 'not-a-hash')`,
        [randomUUID(), s.studioId, s.clientId, start, end],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("enforces the partial unique on the hash", async () => {
    const raw = generateAppointmentToken();
    await insertHashOnly(raw);
    await expect(insertHashOnly(raw)).rejects.toMatchObject({ code: "23505" });
  });

  it("cancel RPC matches by hash and rejects an unknown token", async () => {
    const raw = generateAppointmentToken();
    const id = await insertHashOnly(raw);

    // Wrong token: hash of a different raw value does not match.
    const wrong = await adminQuery(
      `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [hashAppointmentToken(generateAppointmentToken()), null, null, null, false],
    );
    expect(wrong.rows[0].result).toBe("invalid_token");

    // Correct hash cancels.
    const ok = await adminQuery(
      `select result, appointment_id from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [hashAppointmentToken(raw), null, null, null, false],
    );
    expect(ok.rows[0].result).toBe("cancelled");
    expect(ok.rows[0].appointment_id).toBe(id);

    const after = await adminQuery(
      `select status from public.appointments where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("cancelled");
  });

  it("cancel RPC rejects a RAW token (0091: deploy-window tolerance removed)", async () => {
    const raw = generateAppointmentToken();
    await insertHashOnly(raw);
    // The OLD-app deploy-window behavior (passing the raw token) is gone:
    // the RPC matches cancellation_token_hash only, so a raw token whose
    // hash is NOT itself stored returns invalid_token.
    const res = await adminQuery(
      `select result from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [raw, null, null, null, false],
    );
    expect(res.rows[0].result).toBe("invalid_token");
  });




});
