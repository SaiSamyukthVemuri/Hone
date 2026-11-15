// What the owner is told before taking a person's access away or giving it back (deactivate_staff_member / reactivate_staff_member, 0342).
// Pure, so the wording is testable. The core decides everything else (self, owner, already inactive, upcoming appointments, the operator gate);
// none of that is predicted here.

export type StaffAccessCopy = {
  title: (name: string) => string;
  bullets: string[];
  reasonLabel: string;
  confirmLabel: string;
  doneLine: (name: string, upcoming?: number) => string;
};

export const REMOVE_ACCESS_COPY: StaffAccessCopy = {
  title: (name) => `Remove ${name}'s access`,
  bullets: [
    "They lose access to this studio straight away: clinical records, client details and calendars. They keep their own sign-in.",
    "Nothing is deleted. Their past notes, appointments and history stay as they are.",
    "Any upcoming appointments stay assigned to them until you move or cancel them from the calendar.",
    "It is recorded in the history with your reason.",
  ],
  reasonLabel: "Why (required)",
  confirmLabel: "Remove access",
  doneLine: (name, upcoming) =>
    `${name}'s access was removed. It is in the history.` +
    (upcoming && upcoming > 0 ? ` They still have ${upcoming} upcoming appointment${upcoming === 1 ? ", which stays" : "s, which stay"} assigned to them. Move or cancel ${upcoming === 1 ? "it" : "them"} from the calendar.` : ""),
};

/** The plain line shown instead of a Restore control while restoring is not switched on for the studio (no control, nothing to press). */
export const RESTORE_UNAVAILABLE_LINE = "Restoring access is not available yet.";

export const RESTORE_ACCESS_COPY: StaffAccessCopy = {
  title: (name) => `Restore ${name}'s access`,
  bullets: [
    "They get the access set in Permissions for their role, not anything they had before.",
    "Restoring a practitioner gives clinical access again, so a reason is required.",
    "It is recorded in the history with your reason.",
  ],
  reasonLabel: "Why (required)",
  confirmLabel: "Restore access",
  doneLine: (name) => `${name}'s access was restored. It is in the history.`,
};
