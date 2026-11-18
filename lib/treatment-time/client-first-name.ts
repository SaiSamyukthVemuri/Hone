// HON-58: the treatment-time sentence in a client email ("This will be Fern's first electrolysis session.") names the client
// by the name they go by, the same rule every other client communication uses (clientCommunicationName: preferred, else stored).
// It used to take the first word of the STORED name, so a client with a preferred name was greeted by the name they had
// asked not to be called. A client with no preferred name is unchanged (the first word of the stored name).
//
// The scan and operation reads that feed the reminder do not carry preferred_name, and the closed email DTO is not widened
// here, so the preferred name is read separately, once, right before the line is built. That read is fail-soft: any error
// (including the column being absent before 0258) leaves the stored name, which is today's behaviour, never a failed send.

import { clientCommunicationName, type ClientIdentityFields } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

/** The first word of the communication name (preferred, else stored); the whole name when it has no space. */
export function treatmentTimeFirstName(client: ClientIdentityFields): string {
  const full = clientCommunicationName(client);
  return full.split(/\s+/)[0] || full;
}

type ReadClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        eq: (column: string, value: string) => {
          maybeSingle: () => PromiseLike<{
            data: { name?: string | null; preferred_name?: string | null } | null;
            error: { code?: string | null; message?: string | null } | null;
          }>;
        };
      };
    };
  };
};

/**
 * The identity fields to name the client by in the treatment-time line: the stored name the caller already holds plus the
 * preferred name when one exists. Scoped to the studio. Never throws; on any failure returns the stored name alone.
 */
export async function loadTreatmentTimeNameFields(
  admin: unknown,
  studioId: string,
  clientId: string,
  storedName: string,
): Promise<ClientIdentityFields> {
  try {
    const { data, error } = await readWithPreferredName((includePreferred) =>
      (admin as ReadClient)
        .from("clients")
        .select(`${preferredNameColumn(includePreferred)}name`)
        .eq("id", clientId)
        .eq("studio_id", studioId)
        .maybeSingle(),
    );
    if (error || !data) return { name: storedName };
    return { name: storedName, preferred_name: data.preferred_name ?? null };
  } catch {
    return { name: storedName };
  }
}
