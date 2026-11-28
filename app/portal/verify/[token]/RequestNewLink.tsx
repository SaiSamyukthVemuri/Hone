"use client";

import { useActionState } from "react";
import { requestReplacementPortalLink } from "./actions";

export function RequestNewLink({ token }: { token: string }) {
  const [state, action, pending] = useActionState(requestReplacementPortalLink, "ready");
  if (state === "requested") {
    return (
      <div role="status" className="space-y-2">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p>If we could match this link, we sent a new one to your registered email. If it doesn’t arrive, contact your studio for a new portal link.</p>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={pending} className="min-h-11 self-start bg-[#0A0A0A] px-6 py-3 text-[#FAFAF7] disabled:opacity-60">
        {pending ? "Requesting…" : "Email me a new link"}
      </button>
      {state === "limited" && <p role="status">Too many requests. Please try again in a few minutes.</p>}
    </form>
  );
}
