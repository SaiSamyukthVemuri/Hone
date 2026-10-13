// LOCAL-ONLY synthetic Fett twin (#825 6154587789 / 6156413624): the OWNERSHIP MANIFEST.
//
// Every row the twin owns has a DETERMINISTIC id derived from a fixed namespace and a label, so an
// existing twin can be PROVEN to be this twin rather than accepted on its slug alone. The validator
// below is what the seed uses for idempotence: it returns "absent", "verified", or a precise refusal
// listing every mismatch, never a silent pass.
import { createHash } from "node:crypto";
import { adminQuery } from "../db/helpers/harness";

export const TWIN = {
  slug: "fett-twin",
  slugCa: "fett-twin-ca",
  name: "SYNTH-FETT Twin Clinic (LA)",
  nameCa: "SYNTH-FETT Twin Canada (regression)",
  timezone: "America/Los_Angeles",
  domain: "@fett-twin.synth.local",
  treatingCount: 5,
  clientCount: 12,
} as const;

/** A stable UUID (RFC 4122 v5-shaped) for a twin-owned row. Same label, same id, every run. */
export function twinId(label: string): string {
  const h = createHash("sha1").update(`hone-fett-twin/v1/${label}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const IDS = {
  studio: twinId("studio"),
  studioCa: twinId("studio-ca"),
  consult: twinId("service:consultation"),
  treatment: twinId("service:treatment"),
  caService: twinId("service:ca-treatment"),
  client: (i: number) => twinId(`client:${i}`),
  caClient: twinId("client:ca"),
};

export const EMAILS = {
  owner: `owner${TWIN.domain}`,
  treating: (i: number) => `electrologist-${i}${TWIN.domain}`,
  desk: `front-desk${TWIN.domain}`,
  operator: `twin-operator${TWIN.domain}`,
  caOwner: `ca-owner${TWIN.domain}`,
};

export type TwinVerdict =
  | { state: "absent" }
  | { state: "verified"; facts: Record<string, unknown> }
  | { state: "refused"; problems: string[]; recovery: string };

const RECOVERY =
  "This is not a complete twin owned by this manifest. Do NOT reseed over it and do NOT delete it by hand " +
  "(settlements and setup readings are immutable by design). Recover with the guarded isolated reset, " +
  "scripts/fett-twin/reset.sh, which re-checks the target project/port/container and reseeds from scratch.";

/** Prove an existing fett-twin is THIS twin and complete. Read-only. */
export async function validateTwin(): Promise<TwinVerdict> {
  const bySlug = (await adminQuery(`select id, name, owner_email, timezone from public.studios where slug = $1`, [TWIN.slug])).rows[0];
  const byId = (await adminQuery(`select slug from public.studios where id = $1`, [IDS.studio])).rows[0];
  if (!bySlug && !byId) return { state: "absent" };

  const problems: string[] = [];
  if (!bySlug) problems.push(`owned studio id ${IDS.studio} exists under another slug (${byId?.slug})`);
  if (bySlug && bySlug.id !== IDS.studio) problems.push(`slug ${TWIN.slug} belongs to UNRELATED studio ${bySlug.id} (expected ${IDS.studio})`);
  if (bySlug && bySlug.owner_email !== EMAILS.owner) problems.push(`owner_email ${bySlug.owner_email} ≠ ${EMAILS.owner}`);
  if (bySlug && bySlug.timezone !== TWIN.timezone) problems.push(`timezone ${bySlug.timezone} ≠ ${TWIN.timezone}`);
  if (problems.length) return { state: "refused", problems, recovery: RECOVERY };

  const f = (
    await adminQuery(
      `select
         (select count(*) from public.practitioners where studio_id = $1 and active and role = 'owner')::int as owners,
         (select count(*) from public.practitioners where studio_id = $1 and active and role = 'practitioner')::int as treating,
         (select count(*) from public.studio_receptionists where studio_id = $1 and active)::int as receptionists,
         (select count(*) from public.clients where studio_id = $1 and id = any($2::uuid[]))::int as clients,
         (select payment_country || '/' || payment_currency from public.studio_payment_jurisdictions where studio_id = $1) as jurisdiction,
         (select practitioner_capacity_enabled and practitioner_capacity_booking_enabled from public.studios where id = $1) as capacity_live,
         (select count(*) from public.studio_machines where studio_id = $1)::int as machines,
         (select count(*) from public.studio_machines where studio_id = $1 and retired_at is not null)::int as retired_machines,
         (select count(distinct machine_profile_id) from public.studio_machines where studio_id = $1)::int as machine_models,
         (select count(*) from public.treatment_setup_captures where studio_id = $1)::int as captures,
         (select count(*) from public.appointment_settlements where studio_id = $1)::int as settlements,
         (select count(*) from public.delivery_incidents where studio_id = $1)::int as incidents,
         (select count(*) from public.studios where id = $3 and slug = $4)::int as ca_studio,
         (select send_confirmation_sms or send_24h_sms_reminders or send_2h_sms_reminders from public.studios where id = $1) as any_sms_toggle,
         (select count(*) from public.clients where studio_id = $1 and sms_consent_at is not null)::int as sms_consented`,
      [IDS.studio, Array.from({ length: TWIN.clientCount }, (_, i) => IDS.client(i + 1)), IDS.studioCa, TWIN.slugCa],
    )
  ).rows[0];

  const expect = (cond: boolean, msg: string) => {
    if (!cond) problems.push(msg);
  };
  expect(f.owners === 1, `owners ${f.owners} ≠ 1`);
  expect(f.treating === TWIN.treatingCount, `treating practitioners ${f.treating} ≠ ${TWIN.treatingCount}`);
  expect(f.receptionists === 1, `active receptionists ${f.receptionists} ≠ 1`);
  expect(f.clients === TWIN.clientCount, `owned clients ${f.clients} ≠ ${TWIN.clientCount}`);
  expect(f.jurisdiction === "US/usd", `jurisdiction ${f.jurisdiction} ≠ US/usd`);
  expect(f.capacity_live === true, "capacity is not LIVE");
  expect(f.machines >= 3 && f.retired_machines >= 1, `machines ${f.machines} (retired ${f.retired_machines}); expected ≥3 with ≥1 retired`);
  expect(f.machine_models >= 2, `distinct synthetic models ${f.machine_models} < 2`);
  expect(f.captures >= 3, `setup captures ${f.captures} < 3`);
  expect(f.settlements >= 1, `settlements ${f.settlements} < 1`);
  expect(f.incidents >= 2, `delivery incidents ${f.incidents} < 2`);
  expect(f.ca_studio === 1, "Canadian regression studio missing");
  expect(f.any_sms_toggle === false, "an SMS toggle is ON (the twin must never attempt an SMS)");
  expect(f.sms_consented === 0, `${f.sms_consented} client(s) hold SMS consent (must be 0)`);
  return problems.length ? { state: "refused", problems, recovery: RECOVERY } : { state: "verified", facts: f };
}
