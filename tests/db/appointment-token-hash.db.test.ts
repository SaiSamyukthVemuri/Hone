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
// (migration 0090). These tests prove the security-critical invariants
// against the real local Postgres:
//
//   * The TS lookup hash (hashAppointmentToken) and the SQL storage hash
//     (extensions.digest backfill + trigger) produce the SAME value, so a
//     URL token looked up by the app matches a row hashed by the DB.
//   * The BEFORE trigger auto-hashes a raw token (deploy-window safety).
//   * New rows can be stored hash-only (raw column NULL) — no raw token
//     at rest.
//   * The cancel + reschedule RPCs match by hash, and also tolerate a raw
//     token (the in-flight OLD-app deploy window) without corrupting the
//     hash column.
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

function insertRawOnly(token: string) {
  const id = randomUUID();
  const { start, end } = nextSlot();
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status,
        cancellation_token)
     values ($1, $2, $3, $4, $5, 60, 0, $5, 'confirmed', $6)
     returning id`,
    [id, s.studioId, s.clientId, start, end, token],
  ).then((r) => r.rows[0].id as string);
}

describe("appointment token hash-at-rest (migration 0090)", () => {
  it("TS hash and SQL digest agree (lookup matches storage)", async () => {
    const raw = generateAppointmentToken();
    const tsHash = hashAppointmentToken(raw);
    // node crypto cross-check of the helper itself.
    expect(tsHash).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(tsHash).toMatch(/^[a-f0-9]{64}$/);
    // SQL digest (the backfill + trigger expression) must equal it.
    const r = await adminQuery(
      `select encode(extensions.digest($1, 'sha256'), 'hex') as h`,
      [raw],
    );
    expect(r.rows[0].h).toBe(tsHash);
  });

  it("trigger auto-hashes a raw insert (deploy-window safety)", async () => {
    const raw = generateAppointmentToken();
    const id = await insertRawOnly(raw);
    const r = await adminQuery(
      `select cancellation_token, cancellation_token_hash
         from public.appointments where id = $1`,
      [id],
    );
    expect(r.rows[0].cancellation_token).toBe(raw);
    expect(r.rows[0].cancellation_token_hash).toBe(hashAppointmentToken(raw));
  });

  it("stores hash-only rows (no raw token at rest for new appointments)", async () => {
    const raw = generateAppointmentToken();
    const id = await insertHashOnly(raw);
    const r = await adminQuery(
      `select cancellation_token, cancellation_token_hash
         from public.appointments where id = $1`,
      [id],
    );
    expect(r.rows[0].cancellation_token).toBeNull();
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

  it("cancel RPC tolerates a raw token during the deploy window", async () => {
    const raw = generateAppointmentToken();
    const id = await insertRawOnly(raw); // trigger also sets the hash
    const ok = await adminQuery(
      `select result, appointment_id from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [raw, null, null, null, false], // OLD app passes the raw token
    );
    expect(ok.rows[0].result).toBe("cancelled");
    expect(ok.rows[0].appointment_id).toBe(id);
  });

  it("reschedule RPC matches by hash and stores the new token hash-only", async () => {
    const raw = generateAppointmentToken();
    const id = await insertHashOnly(raw);
    const newRaw = generateAppointmentToken();
    const target = nextSlot();
    const r = await adminQuery(
      `select result, new_appointment_id
         from public.reschedule_appointment($1,$2,$3,$4,$5,$6)`,
      [
        id,
        hashAppointmentToken(raw), // current token, as hash
        target.start,
        target.end,
        60,
        hashAppointmentToken(newRaw), // new token, as hash
      ],
    );
    expect(r.rows[0].result).toBe("success");
    const newId = r.rows[0].new_appointment_id as string;

    const newRow = await adminQuery(
      `select cancellation_token, cancellation_token_hash, status
         from public.appointments where id = $1`,
      [newId],
    );
    expect(newRow.rows[0].status).toBe("confirmed");
    expect(newRow.rows[0].cancellation_token).toBeNull(); // hash-only
    expect(newRow.rows[0].cancellation_token_hash).toBe(
      hashAppointmentToken(newRaw),
    );

    const orig = await adminQuery(
      `select status from public.appointments where id = $1`,
      [id],
    );
    expect(orig.rows[0].status).toBe("cancelled");
  });

  it("reschedule RPC tolerates a raw new-token during the deploy window without corrupting the hash column", async () => {
    const raw = generateAppointmentToken();
    const id = await insertHashOnly(raw);
    const newRaw = generateAppointmentToken();
    const target = nextSlot();
    const r = await adminQuery(
      `select result, new_appointment_id
         from public.reschedule_appointment($1,$2,$3,$4,$5,$6)`,
      [
        id,
        hashAppointmentToken(raw),
        target.start,
        target.end,
        60,
        newRaw, // OLD app passes a RAW new token
      ],
    );
    expect(r.rows[0].result).toBe("success");
    const newId = r.rows[0].new_appointment_id as string;
    const newRow = await adminQuery(
      `select cancellation_token, cancellation_token_hash
         from public.appointments where id = $1`,
      [newId],
    );
    // Raw routed to the raw column; the trigger backfilled a valid hash.
    expect(newRow.rows[0].cancellation_token).toBe(newRaw);
    expect(newRow.rows[0].cancellation_token_hash).toBe(
      hashAppointmentToken(newRaw),
    );
  });
});
