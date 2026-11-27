"use client";

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

// "unknown" (could not be read) and "available" leave the choice open: the database refuses a receptionist invitation when the Front Desk is off
// or no seat is free (0390), so this prop only decides what to OFFER and what to say.
export type ReceptionistInvites = "available" | "off" | "full" | "unknown";

export function InviteForm({ receptionistInvites = "unknown" }: { receptionistInvites?: ReceptionistInvites }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"practitioner" | "owner" | "receptionist">("practitioner");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();
  // Typed-but-unsent invitation details count as unsaved edits.
  useUnsavedChangesGuard(
    "team-invite",
    status.kind !== "success" &&
      (email !== "" || displayName !== "" || role !== "practitioner"),
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
      setRole("practitioner");
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

  const sending = status.kind === "sending";

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
            setRole(
              e.target.value === "owner"
                ? "owner"
                : e.target.value === "receptionist"
                  ? "receptionist"
                  : "practitioner",
            )
          }
          className={fieldControlClass({ fullWidth: false, className: "max-w-xs" })}
        >
          <option value="practitioner">Practitioner</option>
          <option value="owner">Owner</option>
          <option value="receptionist" disabled={receptionistInvites === "off" || receptionistInvites === "full"}>
            Receptionist (front desk){receptionistInvites === "off" ? " - not switched on" : receptionistInvites === "full" ? " - no free seat" : ""}
          </option>
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={sending}
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
