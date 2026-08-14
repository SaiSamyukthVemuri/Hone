// PR #254: pure input validation/normalization for the internal New Studio
// Wizard (app/admin/studios/new). No I/O, the operator gate (isAdmin) and the
// service-role inserts live in the server action. Kept pure so the rules are
// unit-tested directly without mocking Supabase.

export type NewStudioInput = {
  name: string;
  slug: string;
  ownerDisplayName: string;
  ownerEmail: string;
  timezone: string;
  bookingDescription: string | null;
  address: string | null;
};

export type ParseResult =
  | { ok: true; value: NewStudioInput }
  | { ok: false; error: string };

// Mirrors app/(app)/settings/booking/actions.ts SLUG_RE so wizard-created
// slugs obey the same rules as the booking surface: lowercase alnum + hyphens,
// no leading/trailing hyphen, 1–64 chars. Kept local (not shared) to avoid
// modifying the booking action in this PR.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Routes the marketing/app/admin surface owns; a studio booking slug may not
// collide with one. Superset of the booking action's reserved list (adds the
// routes introduced since: demo, manage, no-access, portal, records).
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "auth",
  "book",
  "calendar",
  "clients",
  "dashboard",
  "data",
  "demo",
  "intake",
  "login",
  "manage",
  "no-access",
  "portal",
  "pricing",
  "privacy",
  "records",
  "reschedule",
  "settings",
  "terms",
]);

// IANA time-zone validation. There is no canonical zone list or validator
// anywhere in the codebase (the booking action accepts the raw string), so the
// wizard validates here: Intl throws RangeError for an unknown zone.
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseNewStudioInput(raw: {
  name?: unknown;
  slug?: unknown;
  ownerDisplayName?: unknown;
  ownerEmail?: unknown;
  timezone?: unknown;
  bookingDescription?: unknown;
  address?: unknown;
}): ParseResult {
  const name = str(raw.name);
  if (!name) return { ok: false, error: "Studio name is required." };

  const ownerDisplayName = str(raw.ownerDisplayName);
  if (!ownerDisplayName) {
    return { ok: false, error: "Owner display name is required." };
  }

  const ownerEmail = normalizeEmail(str(raw.ownerEmail));
  if (!ownerEmail) return { ok: false, error: "Owner email is required." };
  if (!EMAIL_RE.test(ownerEmail)) {
    return { ok: false, error: "Owner email is not a valid email address." };
  }

  const slug = str(raw.slug).toLowerCase();
  if (!slug) return { ok: false, error: "Booking slug is required." };
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error:
        "Booking slug must be lowercase letters, numbers, and hyphens (no spaces), 1–64 characters.",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: `Booking slug "${slug}" is reserved.` };
  }

  // Default matches the manual runbook and studios.timezone column default.
  const timezone = str(raw.timezone) || "America/Toronto";
  if (!isValidTimeZone(timezone)) {
    return { ok: false, error: `"${timezone}" is not a valid IANA time zone.` };
  }

  return {
    ok: true,
    value: {
      name,
      slug,
      ownerDisplayName,
      ownerEmail,
      timezone,
      bookingDescription: str(raw.bookingDescription) || null,
      address: str(raw.address) || null,
    },
  };
}
