// DELIVERY-VISIBILITY-02 — the plain-English reading of a delivery incident
// (migration 0215), shared by the owner card and the support queue.
//
// Truthful by construction: each failure class says what the provider reported
// and nothing more, and the next step names who can act. A bounce is the
// client's address; a provider failure or refusal is Hone's to look at. No
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

export function describeIncident(row: Pick<OwnerIncident, "channel" | "purpose" | "failure_class">): {
  title: string;
  meaning: string;
  nextStep: string;
  owner: "studio" | "hone";
} {
  const channelWord = row.channel === "email" ? "email" : "text";
  const reading = READING[row.channel]?.[row.failure_class] ?? {
    meaning: "The provider reported a problem sending it.",
    nextStep: "Contact Hone support.",
    owner: "hone" as const,
  };
  return { title: `${purposeLabel(row.purpose)} ${channelWord} not delivered`, ...reading };
}
