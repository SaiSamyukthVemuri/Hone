"use client";

import type { InvitationRole } from "@/lib/types/database";
import { hasTeamSeat, type TeamSeats } from "@/lib/subscriptions/team-seats";
import { useState, useTransition } from "react";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { invitePractitionerAction } from "./actions";
import { fieldControlClass } from "@/components/ui/field";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  | { kind: "success"; email: string; copied: boolean };

function buildShareMessage(email: string): string {
  return `Tell ${email}: visit hone.care, click Sign in, use ${email}. They will be added to your team automatically.`;
}

export function InviteForm({
  seats = null,
  deskEnabled = false,
}: {
  seats?: TeamSeats | null;
  deskEnabled?: boolean;
}) {
  const canInvitePractitioner = !seats || hasTeamSeat(seats, "practitioner");
  const showReceptionist = !seats || (seats.receptionist_limit > 0 && deskEnabled);
  const canInviteReceptionist = showReceptionist && (!seats || hasTeamSeat(seats, "receptionist"));
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const defaultRole = canInvitePractitioner ? "practitioner" : "receptionist";
  const [chosenRole, setRole] = useState<InvitationRole | null>(null);
  const role = chosenRole ?? defaultRole;
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();
  // Typed-but-unsent invitation details count as unsaved edits.
  useUnsavedChangesGuard(
    "team-invite",
    status.kind !== "success" &&
      (email !== "" || displayName !== "" || (chosenRole !== null && chosenRole !== defaultRole)),
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: "sending" });

    const fd = new FormData();
    fd.set("email", email);
    fd.set("display_name", displayName);
    fd.set("role", role);

    startTransition(async () => {
      const result = await invitePractitionerAction(fd);
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error });
        return;
      }
      setStatus({ kind: "success", email: result.email, copied: false });
      setEmail("");
      setDisplayName("");
      setRole(null);
    });
  }

  async function handleCopy() {
    if (status.kind !== "success") return;
    const message = buildShareMessage(status.email);
    try {
      await navigator.clipboard.writeText(message);
      setStatus({ ...status, copied: true });
      window.setTimeout(() => {
        setStatus((s) => (s.kind === "success" ? { ...s, copied: false } : s));
      }, 1500);
    } catch {
      // Clipboard API unavailable. Leave the message visible so the user can select+copy manually.
    }
  }

  if (status.kind === "success") {
    const message = buildShareMessage(status.email);
    return (
      <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-sm font-medium">Invite created for {status.email}.</p>
        <pre className="whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-white p-3 text-sm leading-[1.55] text-neutral-800 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
{message}
        </pre>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-950"
          >
            {status.copied ? "Copied" : "Copy message"}
          </button>
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="text-sm text-neutral-600 hover:underline dark:text-neutral-400"
          >
            Send another invite
          </button>
        </div>
      </div>
    );
  }

  if (!canInvitePractitioner && !canInviteReceptionist) {
    return <p className="text-sm">No team seats are available to invite. Review active members and pending invitations.</p>;
  }
  const sending = status.kind === "sending";
  const selectedRoleAvailable = role === "receptionist" ? canInviteReceptionist : canInvitePractitioner;

  return (
    <form onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Email<span className="ml-1 text-red-500">*</span>
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className={fieldControlClass({ fullWidth: false })}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Optional"
            className={fieldControlClass({ fullWidth: false })}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Role</span>
        <select
          value={role}
          onChange={(e) =>
            setRole(e.target.value as InvitationRole)
          }
          className={fieldControlClass({ fullWidth: false, className: "max-w-xs" })}
        >
          <option value="practitioner" disabled={!canInvitePractitioner}>Practitioner</option>
          <option value="owner" disabled={!canInvitePractitioner}>Owner</option>
          {showReceptionist && <option value="receptionist" disabled={!canInviteReceptionist}>Receptionist (front desk)</option>}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={sending || !selectedRoleAvailable}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {sending ? "Sending" : "Create invite"}
        </button>
        {status.kind === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {status.message}
          </span>
        )}
      </div>
    </form>
  );
}
