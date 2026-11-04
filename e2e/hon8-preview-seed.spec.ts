import { test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { MACHINE_CATALOGUE } from "../lib/machines/catalogue";

// HON-8 PREVIEW SEED (not a test of anything). Creates ONE synthetic studio for the practitioner preview: a synthetic owner who has
// already registered both units (registration is owner-only), one synthetic practitioner (role practitioner) who is the person that
// signs in, and one synthetic client. Writes only addresses and ids (no password exists; sign-in is a one-time link made on the VPS)
// to the file named by HON8_PREVIEW_SEED_OUT. The contracts must already be published through the D4 path.
test("seed the synthetic preview studio", async () => {
  const out = process.env.HON8_PREVIEW_SEED_OUT;
  if (!out) throw new Error("set HON8_PREVIEW_SEED_OUT");
  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  await sql(`update public.practitioners set display_name = 'Synthetic Practitioner' where id = $1`, [member.practitionerId]);
  await sql(`update public.studios set name = 'Synthetic Preview Studio' where id = $1`, [seed.studioId]);
  const client = { id: randomUUID(), name: "Synthetic Client" };
  await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [client.id, seed.studioId, client.name, `synthetic-client-${seed.runId}@harness.local`]);
  const units: Record<string, string> = {};
  for (const p of MACHINE_CATALOGUE.filter((p) => p.version === 3 && p.availability === "active" && p.profileId.startsWith("dectro-apilus:"))) {
    const id = randomUUID();
    await sql(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,$4,$5)`,
      [id, seed.studioId, p.profileId, p.version, `${p.model} (synthetic)`]);
    units[p.model] = id;
  }
  writeFileSync(out, JSON.stringify({ studioId: seed.studioId, practitionerEmail: member.email, ownerEmail: seed.ownerEmail, clientId: client.id, clientName: client.name, units }, null, 2), { mode: 0o600 });
});
