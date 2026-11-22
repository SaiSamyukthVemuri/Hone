import { randomUUID } from "node:crypto";
import { adminQuery } from "./harness";

// ONE CLIENT PER PRACTITIONER, for fixtures that book two practitioners at the same time.
//
// A client holds one live appointment per service and exact start (the database refuses a second), so a fixture that books the SAME client with the same
// service at the same start for two different practitioners is no longer a valid booking. Those fixtures are about two PRACTITIONERS working in parallel,
// not about one client, so each practitioner gets their own synthetic client here. A booking for the same practitioner reuses that practitioner's client,
// so every same-practitioner collision a test asserts is unchanged.
const cache = new Map<string, string>();

export async function clientFor(studioId: string, practitionerId: string): Promise<string> {
  const key = `${studioId}:${practitionerId}`;
  const known = cache.get(key);
  if (known) return known;
  const id = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,$3)`, [id, studioId, `SYNTH client for ${practitionerId.slice(0, 8)}`]);
  cache.set(key, id);
  return id;
}
