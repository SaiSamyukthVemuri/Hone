// Client profile save: write only what the staff member changed, and only if nobody else changed it first.
//
// The edit form used to post every field it loaded, and the action wrote all of them back, so a tab opened
// before an intake sync or another staff edit silently reverted the newer value, and an older form that omitted
// a field blanked it. The form now carries the values it LOADED (the baseline, exactly as stored). The action
// compares each submitted field with its baseline, writes only the fields that changed, and makes the write
// conditional: `where <column> is not distinct from <baseline>` for every changed column, so zero rows means
// somebody else changed one of them (or the client is gone) and nothing is written.
//
// App-only interim: the baseline comes from the browser, which is fine because it is only a precondition; it
// can never widen what the caller may write (role, studio and RLS are checked server-side as before).
// A database revision (held migration M1/M2) replaces this later.
import { parsePreferredName } from "@/lib/clients/identity";

export const PROFILE_KEYS = [
  "name",
  "preferred_name",
  "pronouns",
  "date_of_birth",
  "phone",
  "email",
  "address",
  "fitzpatrick_type",
  "allergies",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export type BaselineValue = string | number | null;
export type ProfileBaseline = Record<ProfileKey, BaselineValue>;

export const STALE_FORM_ERROR =
  "This page is out of date. Reload it and make your change again; nothing was saved.";
export const CHANGED_BY_SOMEONE_ELSE_ERROR =
  "Someone else changed this client after you opened this page. Nothing was saved. Review the changes below.";
export const NOT_SAVED_ERROR = "Not saved. Reload the page and try again.";
export const CLEAR_PREFERRED_ERROR =
  "To remove the preferred name, press Remove preferred name. Otherwise type a name.";

export const PROFILE_FIELD_LABELS: Record<ProfileKey, string> = {
  name: "Name",
  preferred_name: "Preferred name",
  pronouns: "Pronouns",
  date_of_birth: "Date of birth",
  phone: "Phone",
  email: "Email",
  address: "Address",
  fitzpatrick_type: "Fitzpatrick type",
  allergies: "Allergies",
  emergency_contact_name: "Emergency contact name",
  emergency_contact_phone: "Emergency contact phone",
};

/** The values the page loaded, exactly as stored (raw, so the conditional write can compare them). */
export function baselineFromRow(row: Record<string, unknown>): ProfileBaseline {
  const out = {} as ProfileBaseline;
  for (const key of PROFILE_KEYS) {
    const v = row[key];
    out[key] = typeof v === "string" || typeof v === "number" ? v : null;
  }
  return out;
}

/** Strict: every key present, each a string, number or null. Anything else is not a baseline. */
export function parseBaseline(raw: unknown): ProfileBaseline | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 20_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const out = {} as ProfileBaseline;
  for (const key of PROFILE_KEYS) {
    if (!(key in rec)) return null;
    const v = rec[key];
    if (v !== null && typeof v !== "string" && typeof v !== "number") return null;
    out[key] = v;
  }
  return out;
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

function intOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : value.trim() === "" ? NaN : parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** A stored or baseline value, put in the same shape a submission is parsed into. */
function normalizeStored(key: ProfileKey, raw: BaselineValue): string | number | null {
  if (key === "fitzpatrick_type") return intOrNull(raw);
  if (key === "preferred_name") {
    const parsed = parsePreferredName(raw === null ? null : String(raw));
    return parsed.ok ? parsed.value : trimmedOrNull(raw === null ? null : String(raw));
  }
  return trimmedOrNull(raw === null ? null : String(raw));
}

export type ProfilePlan =
  | {
      ok: true;
      /** Only the changed columns, parsed. Empty = nothing to save. */
      patch: Partial<Record<ProfileKey, string | number | null>>;
      /** The stored value each changed column must still have for the write to apply. */
      conditions: Array<{ key: ProfileKey; value: BaselineValue }>;
    }
  | { ok: false; error: string };

/**
 * Decide what to write. A key absent from the submission is never a candidate, so an omitted field can never
 * clear anything. A present key is written only when it differs from the baseline.
 */
export function planProfileUpdate(formData: FormData, baseline: ProfileBaseline): ProfilePlan {
  const patch: Partial<Record<ProfileKey, string | number | null>> = {};
  const conditions: Array<{ key: ProfileKey; value: BaselineValue }> = [];

  for (const key of PROFILE_KEYS) {
    if (!formData.has(key)) continue;
    const raw = formData.get(key);
    let submitted: string | number | null;
    if (key === "name") {
      submitted = typeof raw === "string" ? trimmedOrNull(raw) : null;
      if (!submitted) return { ok: false, error: "Name is required." };
    } else if (key === "preferred_name") {
      const parsed = parsePreferredName(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      submitted = parsed.value;
    } else if (key === "fitzpatrick_type") {
      submitted = typeof raw === "string" ? intOrNull(raw) : null;
    } else {
      submitted = typeof raw === "string" ? trimmedOrNull(raw) : null;
    }

    const before = normalizeStored(key, baseline[key]);
    if (submitted === before) continue;

    if (key === "preferred_name" && submitted === null && before !== null && formData.get("clear_preferred_name") !== "yes") {
      return { ok: false, error: CLEAR_PREFERRED_ERROR };
    }
    patch[key] = submitted;
    conditions.push({ key, value: baseline[key] });
  }
  return { ok: true, patch, conditions };
}

export type ProfileConflict = { key: ProfileKey; label: string; current: string; yours: string };

function asFormString(value: BaselineValue | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * After a zero-row conditional write: which changed fields no longer hold their baseline value. Only called after
 * the role and client-access checks, and only returned to the same signed-in staff member; never logged.
 */
export function describeConflicts(
  plan: Extract<ProfilePlan, { ok: true }>,
  stored: Record<string, unknown>,
): ProfileConflict[] {
  const conflicts: ProfileConflict[] = [];
  for (const { key, value } of plan.conditions) {
    const now = stored[key];
    const nowValue: BaselineValue = typeof now === "string" || typeof now === "number" ? now : null;
    if (nowValue === value) continue;
    conflicts.push({
      key,
      label: PROFILE_FIELD_LABELS[key],
      current: asFormString(nowValue),
      yours: asFormString(plan.patch[key] ?? null),
    });
  }
  return conflicts;
}

/** Baseline for the form after the staff member reviewed a conflict: adopt the current stored value. */
export function adoptCurrent(baseline: ProfileBaseline, conflicts: ReadonlyArray<ProfileConflict>): ProfileBaseline {
  const next = { ...baseline };
  for (const c of conflicts) {
    next[c.key] = c.key === "fitzpatrick_type" ? intOrNull(c.current) : c.current === "" ? null : c.current;
  }
  return next;
}
