"use client";
import { useState } from "react";
import { completeStaffWelcome } from "./staff-welcome-action";
import type { StaffRole } from "@/lib/onboarding/staff-welcome";

export function StaffWelcomeDone({
  role,
  membershipId,
}: {
  role: StaffRole;
  membershipId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <button
        className="rounded border px-3 py-2 text-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setFailed(!(await completeStaffWelcome(role, membershipId)));
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        Finish introduction
      </button>
      {failed && (
        <p role="alert">We couldn’t save your preference. Try again.</p>
      )}
    </div>
  );
}
