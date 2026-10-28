// HON-58 — one client identity, two names.
//
// A client row carries ONE stored `name` today (whatever staff typed or the
// booker entered). HON-58 adds an optional preferred name beside it, and a
// separate, stricter legal identity. This module is the single place that
// decides which name a surface shows, so the rule is not restated at every
// `client:clients(name)` read:
//
//   ordinary staff surfaces and client communications -> the PREFERRED identity
//   clinical and insurer-facing output                -> the LEGAL identity
//
// Every field is optional and a missing field falls back to the stored `name`,
// so the module is correct on a database that has none of the new columns:
// nothing changes for an existing row (no backfill, no inference). It is pure,
// it never logs, and it never reads a legal name from anything but the legal
// identity fields it is handed (never from an insurer response).
//
// A caller that must not see legal identity simply does not select it; this
// module cannot widen what was selected.

export type ClientIdentityFields = {
  /** The stored name: the existing `clients.name`. */
  name?: string | null;
  /** The name the client goes by (HON-58). Optional, never inferred. */
  preferred_name?: string | null;
  /** Staff-entered legal identity (HON-58, owner-gated). Optional. */
  legal_given_name?: string | null;
  legal_middle_name?: string | null;
  legal_family_name?: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The legal name as staff entered it, or null when no legal identity is set.
 * Given, middle and family are joined in that order; a missing part is skipped.
 */
export function clientLegalName(client: ClientIdentityFields): string | null {
  const parts = [client.legal_given_name, client.legal_middle_name, client.legal_family_name]
    .map(clean)
    .filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The name an ordinary staff surface (calendar, lookup, lists) shows:
 * `coalesce(nullif(trim(preferred_name), ''), name)`. Never the legal name.
 */
export function clientDisplayName(client: ClientIdentityFields): string {
  return clean(client.preferred_name) || clean(client.name);
}

/** The name an ordinary client communication uses where a name is needed. */
export function clientCommunicationName(client: ClientIdentityFields): string {
  return clientDisplayName(client);
}

/**
 * The name clinical and insurer-facing output uses: the legal identity when
 * one is set, else the stored `name` (today's behaviour, so an existing record
 * prints exactly as before). Never the preferred name alone.
 */
export function clientClinicalName(client: ClientIdentityFields): string {
  return clientLegalName(client) ?? clean(client.name);
}

/**
 * For an authorized staff view that must show both: the display name and, only
 * when it differs from it, the legal name. `legal` is null when there is no
 * legal identity or it is the same as what is displayed.
 */
export function clientIdentityPair(client: ClientIdentityFields): { display: string; legal: string | null } {
  const display = clientDisplayName(client);
  const legal = clientLegalName(client);
  return { display, legal: legal !== null && legal !== display ? legal : null };
}
