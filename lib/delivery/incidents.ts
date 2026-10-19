// DELIVERY-VISIBILITY-02 — the plain-English reading of a delivery incident
// (migration 0215), shared by the owner card and the support queue.
//
// Truthful by construction: each failure class says what the provider reported
// and nothing more, and the next step names who can act. A bounce is the
// client's address; a confirmed invalid-recipient refusal needs studio data
// correction. Other provider refusals are Hone's to look at. No
// sentence claims a message was read, received or lost when the provider did
// not say so.

export type IncidentChannel = "email" | "sms";
export type IncidentFailureClass = "refused" | "bounced" | "failed" | "suppressed" | "undelivered";

export type OwnerIncident = {
  incident_id: string;
  channel: IncidentChannel;
  purpose: string;
  failure_class: IncidentFailureClass;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  last_reason: string | null;
  last_appointment_id: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

/** Owner-only RPC projection. Support's existing incident contract is unchanged. */
export type RetainedFailedAppointment = {
  appointment_id: string;
  last_reason: string | null;
  claimed_at: string;
};
export type OwnerIncidentProjection = OwnerIncident & {
  retained_failed_appointments: RetainedFailedAppointment[];
};

/** Missing new RPC fields fail closed during an app/database rollout mismatch. */
export function hasRetainedFailureProjection(value: unknown): value is OwnerIncidentProjection {
  if (!value || typeof value !== "object") return false;
  const links = (value as OwnerIncidentProjection).retained_failed_appointments;
  if (!Array.isArray(links) || links.length > 200) return false;
  const ids = new Set<string>();
  return links.every((link) => {
    if (!link || typeof link !== "object"
      || typeof link.appointment_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(link.appointment_id)
      || ids.has(link.appointment_id)
      || !(link.last_reason === null || (typeof link.last_reason === "string"
        && /^[a-z][a-z0-9_]{1,63}$/.test(link.last_reason)))
      || typeof link.claimed_at !== "string" || !Number.isFinite(Date.parse(link.claimed_at))) return false;
    ids.add(link.appointment_id);
    return true;
  });
}

const PURPOSE_LABEL: Readonly<Record<string, string>> = {
  appointment_confirmation: "Booking confirmation",
  appointment_reminder_24h: "24-hour reminder",
  appointment_reminder_2h: "2-hour reminder",
  waitlist_invitation: "Waitlist invitation",
  waitlist_join_acknowledgement: "Waitlist sign-up text",
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? purpose.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

type Reading = { meaning: string; nextStep: string; owner: "studio" | "hone" };

const READING: Readonly<Record<IncidentChannel, Partial<Record<IncidentFailureClass, Reading>>>> = {
  email: {
    bounced: {
      meaning: "The client's mail server rejected the email.",
      nextStep: "Check the client's email address with them and update it.",
      owner: "studio",
    },
    suppressed: {
      meaning:
        "The email provider did not send it, because this address bounced or reported spam before.",
      nextStep: "Confirm the address with the client. Hone support can clear it once it is corrected.",
      owner: "studio",
    },
    failed: {
      meaning: "Hone's email provider could not send it.",
      nextStep: "Nothing to change on your side. Contact Hone support if it continues.",
      owner: "hone",
    },
    refused: {
      meaning: "Hone's email provider refused the message when Hone tried to send it.",
      nextStep: "Nothing to change on your side. Contact Hone support if it continues.",
      owner: "hone",
    },
  },
  sms: {
    undelivered: {
      meaning: "The carrier could not deliver the text.",
      nextStep: "Check the client's mobile number with them.",
      owner: "studio",
    },
    failed: {
      meaning: "The text could not be sent.",
      nextStep: "Check the client's mobile number. Contact Hone support if it continues.",
      owner: "studio",
    },
    refused: {
      meaning: "The text provider refused the message when Hone tried to send it.",
      nextStep: "Nothing to change on your side. Contact Hone support if it continues.",
      owner: "hone",
    },
  },
};

export function describeIncident(row: Pick<OwnerIncident, "channel" | "purpose" | "failure_class"> & Partial<Pick<OwnerIncident, "last_reason">>): {
  title: string;
  meaning: string;
  nextStep: string;
  owner: "studio" | "hone";
} {
  const channelWord = row.channel === "email" ? "email" : "text";
  const reading = row.channel === "email" && row.failure_class === "refused" && row.last_reason === "invalid_to_address"
    ? {
        meaning: "The email provider refused the client's invalid email address.",
        nextStep: "Check the client's email address with them and update it.",
        owner: "studio" as const,
      }
    : row.channel === "sms" && row.failure_class === "refused" && row.last_reason === "twilio_21211"
      ? {
          meaning: "The text provider refused the client's invalid mobile number.",
          nextStep: "Check the client's mobile number with them and update it.",
          owner: "studio" as const,
        }
      : READING[row.channel]?.[row.failure_class] ?? {
    meaning: "The provider reported a problem sending it.",
    nextStep: "Contact Hone support.",
    owner: "hone" as const,
  };
  return { title: `${purposeLabel(row.purpose)} ${channelWord} not delivered`, ...reading };
}
