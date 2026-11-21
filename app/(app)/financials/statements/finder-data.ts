import { clientDisplayName } from "@/lib/clients/identity";
import { loadFinderClients, loadLastVisitDates, LAST_VISIT_MAX_CLIENTS } from "@/lib/finance/statement-directory-read";
import { FINDER_CLIENT_CAP, sameNameClientIds } from "@/lib/finance/statement-screen";

import type { ClientsViewProps } from "./clients-view";

// The data behind "Find a client", shared by the Clients tab and the Studio tab. Called ONLY after the owner gate on the page; the loaders repeat it as
// their own first statement. Read-only. Only an id, the shown name and the archived flag are handed to the browser (built here, after the gate).
export async function loadFinderState(
  practitioner: Parameters<typeof loadFinderClients>[0],
  studio: Parameters<typeof loadLastVisitDates>[1],
): Promise<ClientsViewProps["finder"]> {
  const found = await loadFinderClients(practitioner, studio);
  if (!(found.access === "granted" && found.ok)) return { state: "unavailable" };
  if (found.clients.length > FINDER_CLIENT_CAP) return { state: "too_many" };
  const sameName = sameNameClientIds(found.clients);
  // Two clients with one name are told apart by their last visit date; beyond the bound, or on any failure, the screen says only "same name".
  const last = sameName.length <= LAST_VISIT_MAX_CLIENTS ? await loadLastVisitDates(practitioner, studio, sameName) : null;
  const options = found.clients.map((c) => ({ id: c.id, displayName: clientDisplayName({ name: c.name, preferred_name: c.preferredName }), archived: c.archived }));
  return { state: "ok", clients: options, lastVisits: last && last.access === "granted" && last.ok ? last.lastVisit : null };
}
