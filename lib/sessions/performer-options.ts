import type { Practitioner } from "@/lib/types/database";

// DAT-001 minimal returned fields: what SessionPerformerLine (a client
// component) renders and selects. Every prop of a client component reaches
// the browser, so the session page projects practitioner rows to this shape;
// the auth user id, calendar-feed token hash and agreement timestamps stay on
// the server.
export type PerformerOption = Pick<Practitioner, "id" | "display_name" | "email">;

export function toPerformerOptions(
  practitioners: ReadonlyArray<Practitioner>,
): PerformerOption[] {
  return practitioners.map((p) => ({
    id: p.id,
    display_name: p.display_name,
    email: p.email,
  }));
}
