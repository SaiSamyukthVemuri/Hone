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

/** The label a staff or desk surface puts on a stored name shown as the identity. */
export const NAME_ON_FILE_LABEL = "Name on file";

/**
 * True when the displayed name IS the stored name (no preferred name), so the
 * surface should label it "Name on file". The stored name is free text staff
 * entered and may itself be a legal name: it is never treated as protected.
 */
export function isNameOnFile(client: ClientIdentityFields): boolean {
  return clean(client.preferred_name) === "" && clean(client.name) !== "";
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

/** The longest preferred name the database accepts (clients_preferred_name_shape). */
export const PREFERRED_NAME_MAX = 200;

/** Added to a client row type: the HON-58 column, absent on a database without it. */
export type WithPreferredName = { preferred_name?: string | null };

/**
 * Read a preferred name typed into a form. Blank is "no preferred name" (null);
 * runs of spaces collapse; the database check requires the stored value to be
 * trimmed and at most PREFERRED_NAME_MAX characters, so both are enforced here
 * and a too-long value is refused rather than silently cut.
 */
export function parsePreferredName(
  raw: FormDataEntryValue | string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: true, value: null };
  const value = clean(raw);
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > PREFERRED_NAME_MAX) {
    return { ok: false, error: `Preferred name must be ${PREFERRED_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value };
}

export type LegalIdentityInput = {
  legal_given_name: string | null;
  legal_middle_name: string | null;
  legal_family_name: string | null;
};

/**
 * Read a legal identity typed by staff. Each part is trimmed and space-collapsed
 * (blank is "not given"), at most 200 characters (the table's check), and at
 * least a given or a family name is required (the table's check). Nothing is
 * inferred or defaulted: a legal identity is exactly what staff entered.
 */
export function parseLegalIdentity(raw: {
  given?: FormDataEntryValue | string | null;
  middle?: FormDataEntryValue | string | null;
  family?: FormDataEntryValue | string | null;
}): { ok: true; value: LegalIdentityInput } | { ok: false; error: string } {
  const part = (v: FormDataEntryValue | string | null | undefined): string | null =>
    typeof v === "string" ? clean(v) || null : null;
  const value: LegalIdentityInput = {
    legal_given_name: part(raw.given),
    legal_middle_name: part(raw.middle),
    legal_family_name: part(raw.family),
  };
  for (const v of Object.values(value)) {
    if (v !== null && v.length > PREFERRED_NAME_MAX) {
      return { ok: false, error: `Each legal name part must be ${PREFERRED_NAME_MAX} characters or fewer.` };
    }
  }
  if (value.legal_given_name === null && value.legal_family_name === null) {
    return { ok: false, error: "Enter at least a given name or a family name." };
  }
  return { ok: true, value };
}

/**
 * The name on an INTERNAL clinical packet (a printed chart or notes): the legal
 * identity, and the preferred name beside it in parentheses when it differs
 * (OPS Q2). With no legal identity the stored name stands in, exactly as before.
 */
export function clinicalPacketName(client: ClientIdentityFields): string {
  const legal = clientClinicalName(client);
  const preferred = clean(client.preferred_name);
  return preferred && preferred.toLowerCase() !== legal.toLowerCase() ? `${legal} (${preferred})` : legal;
}

/**
 * The name on an INSURER or claim document (OPS Q2): the legal identity only,
 * else the stored name. The preferred name is never printed there.
 */
export function insurerDocumentName(client: ClientIdentityFields): string {
  return clientClinicalName(client);
}
