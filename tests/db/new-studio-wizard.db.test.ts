import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  userQuery,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #254: internal New Studio Wizard, proven at the DB layer on the real
// migrated DB. The wizard's privilege is NOT available to a normal
// authenticated user (RLS blocks studio/invitation creation) — only the
// service-role path the operator-gated action uses can do it, and the existing
// handle_new_user trigger still does the owner account-linking. The app-layer
// operator gate (isAdmin) is invisible to the DB and is pinned by
// tests/app/admin/new-studio-wizard.test.ts instead.

let noStudioUserId: string;

beforeAll(async () => {
  noStudioUserId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    noStudioUserId,
    `newstudio-nostudio-${noStudioUserId.slice(0, 8)}@harness.local`,
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("a normal authenticated user cannot do what the wizard does", () => {
  it("cannot INSERT a studio (no INSERT policy on studios)", async () => {
    await expect(
      userQuery(
        noStudioUserId,
        `insert into public.studios (id, name, owner_email, slug)
         values ($1, 'Rogue', 'rogue@example.com', $2)`,
        [randomUUID(), `rogue-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot INSERT an owner pending_invitation for an arbitrary studio", async () => {
    // Seed a studio via service role (as the wizard would), then prove a
    // non-owner authenticated user cannot attach an owner invite to it.
    const studioId = randomUUID();
    await adminQuery(
      `insert into public.studios (id, name, owner_email, slug)
       values ($1, 'Seeded', 'seed@example.com', $2)`,
      [studioId, `seeded-${studioId.slice(0, 8)}`],
    );
    await expect(
      userQuery(
        noStudioUserId,
        `insert into public.pending_invitations (studio_id, email, role)
         values ($1, 'grab@example.com', 'owner')`,
        [studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("the operator service-role path creates a studio + owner invite, and the trigger links the owner", () => {
  it("inserts studio + owner invitation, applies safe defaults, then provisions the owner on first sign-in", async () => {
    // The wizard's two writes, via the bypassrls (service-role-equivalent) path.
    const studioId = randomUUID();
    const slug = `wizard-${studioId.slice(0, 8)}`;
    const ownerEmail = `wizard-owner-${studioId.slice(0, 8)}@harness.local`;

    await adminQuery(
      `insert into public.studios (id, name, owner_email, slug, timezone)
       values ($1, 'Wizard Studio', $2, $3, 'America/Toronto')`,
      [studioId, ownerEmail, slug],
    );
    await adminQuery(
      `insert into public.pending_invitations (studio_id, email, role, display_name)
       values ($1, $2, 'owner', 'Wizard Owner')`,
      [studioId, ownerEmail],
    );

    // Safe defaults landed (no fee/payment coupling; standard scheduling).
    const studio = await adminQuery(
      `select default_appointment_duration_minutes, buffer_minutes,
              late_cancel_fee_cents, no_show_fee_cents, timezone
         from public.studios where id = $1`,
      [studioId],
    );
    expect(studio.rows[0].default_appointment_duration_minutes).toBe(60);
    expect(studio.rows[0].buffer_minutes).toBe(15);
    expect(studio.rows[0].late_cancel_fee_cents).toBeNull();
    expect(studio.rows[0].no_show_fee_cents).toBeNull();
    expect(studio.rows[0].timezone).toBe("America/Toronto");

    // No practitioner exists yet — the wizard does NOT create one directly.
    const before = await adminQuery(
      `select count(*)::int as n from public.practitioners where studio_id = $1`,
      [studioId],
    );
    expect(before.rows[0].n).toBe(0);

    // The owner signs in (an auth.users row is inserted). handle_new_user is a
    // NO-OP now (migration 0141) — it must NOT fabricate a membership or
    // acceptance. Provisioning + consent happen at sign-in via reconciliation /
    // explicit acceptance instead.
    const ownerUserId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      ownerUserId,
      ownerEmail,
    ]);

    const afterSignin = await adminQuery(
      `select count(*)::int as n from public.practitioners p
         join auth.users u on u.id = p.user_id
        where lower(u.email) = lower($1)`,
      [ownerEmail],
    );
    expect(afterSignin.rows[0].n).toBe(0); // no fabricated membership
    const stillPending = await adminQuery(
      `select status from public.pending_invitations
        where studio_id = $1 and lower(email) = lower($2)`,
      [studioId, ownerEmail],
    );
    expect(stillPending.rows[0].status).toBe("pending"); // recoverable

    // Explicit acceptance (the authoritative consent event, service-role only)
    // provisions exactly one owner practitioner with terms/privacy stamped and
    // accepts the invitation.
    await adminQuery(
      `select public.admin_accept_pending_invitation($1)`,
      [ownerUserId],
    );
    const provisioned = await adminQuery(
      `select p.role, p.active, p.studio_id,
              (p.terms_accepted_at is not null) as terms_ok,
              (p.privacy_accepted_at is not null) as privacy_ok
         from public.practitioners p
         join auth.users u on u.id = p.user_id
        where lower(u.email) = lower($1)`,
      [ownerEmail],
    );
    expect(provisioned.rowCount).toBe(1);
    expect(provisioned.rows[0].role).toBe("owner");
    expect(provisioned.rows[0].active).toBe(true);
    expect(provisioned.rows[0].studio_id).toBe(studioId);
    expect(provisioned.rows[0].terms_ok).toBe(true);
    expect(provisioned.rows[0].privacy_ok).toBe(true);

    const invite = await adminQuery(
      `select status, accepted_at from public.pending_invitations
        where studio_id = $1 and lower(email) = lower($2)`,
      [studioId, ownerEmail],
    );
    expect(invite.rows[0].status).toBe("accepted");
    expect(invite.rows[0].accepted_at).not.toBeNull();
  });
});
