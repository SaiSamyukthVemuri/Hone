import type { Role } from "@/lib/permissions/catalog";
import { ROLE_LABELS } from "./model";

// What the owner is told before moving a person between practitioner and receptionist (change_staff_role, 0287). Pure, so the wording is
// testable and the editor and the tests read one source. The core decides everything else (gate, self, owner, stale role, upcoming
// appointments, email); none of that is predicted here.

export type ChangeRoleCopy = {
  from: Role;
  to: Role;
  title: (name: string) => string;
  bullets: string[];
  reasonRequired: boolean;
  reasonLabel: string;
  confirmLabel: string;
};

export const otherRole = (r: Role): Role => (r === "practitioner" ? "receptionist" : "practitioner");

export function changeRoleCopy(from: Role): ChangeRoleCopy {
  const to = otherRole(from);
  const f = ROLE_LABELS[from].toLowerCase();
  const t = ROLE_LABELS[to].toLowerCase();
  const widens = to === "practitioner";
  return {
    from,
    to,
    title: (name) => `Change ${name} from ${ROLE_LABELS[from]} to ${ROLE_LABELS[to]}`,
    bullets: [
      "It takes effect immediately and is recorded in the history with your reason.",
      `Nothing is deleted. Their ${f} account is switched off and they keep their sign-in.`,
      `They get the ${t} access set in Permissions, not what they had before.`,
      ...(from === "practitioner" ? ["It is refused while they still have upcoming appointments. Move or cancel those first."] : []),
      ...(widens ? ["This gives clinical access, so a reason is required."] : []),
    ],
    reasonRequired: widens,
    reasonLabel: widens ? "Why (required)" : "Why (optional)",
    confirmLabel: `Make ${t}`,
  };
}
