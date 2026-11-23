// HON-106 follow-up / Sam's rule for staff notifications: a notification names the client by the DISPLAY name, the name the calendar shows: the preferred name
// where one is set, otherwise the stored name; and "A client" when neither is available. Never the legal identity.
//
// The preferred name rides on the client row each writer ALREADY reads (through the missing-column-safe helper, so it also works before 0258), so a notification
// costs no extra lookup and cannot wait on one.

import { clientDisplayName, type ClientIdentityFields } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

export const GENERIC_CLIENT_LABEL = "A client";

/** The display name for a notification, or the generic label when the client has no usable name. */
export function notificationClientName(fields: ClientIdentityFields | null | undefined): string {
  return fields ? clientDisplayName(fields) || GENERIC_CLIENT_LABEL : GENERIC_CLIENT_LABEL;
}

type NameRead = {
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
 * ONE read of the client's name fields (stored + preferred), studio-scoped. For the writers whose only client read is the name (card change, cancel, intake).
 * Returns the error untouched so each caller keeps its own policy (the card webhook throws so Stripe retries; the bell writers carry on with the generic label).
 */
export async function readClientNameFields(
  admin: unknown,
  studioId: string,
  clientId: string,
): Promise<{ fields: ClientIdentityFields | null; error: { code?: string | null; message?: string | null } | null }> {
  const { data, error } = await readWithPreferredName((includePreferred) =>
    (admin as NameRead)
      .from("clients")
      .select(`${preferredNameColumn(includePreferred)}name`)
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .maybeSingle(),
  );
  return { fields: data ? { name: data.name ?? null, preferred_name: data.preferred_name ?? null } : null, error };
}
