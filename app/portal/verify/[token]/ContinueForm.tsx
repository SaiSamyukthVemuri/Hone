import { verifyPortalMagicLinkAction } from "./actions";

// Continue-to-portal form. Server-rendered <form> bound directly to
// the server action so the POST stays same-origin protected by the
// Next.js framework. The raw token is passed as a hidden input; it
// never reaches client-side JS state and the form submit goes to
// the same /portal/verify/<token> URL (the action runs there).
export function ContinueToPortalForm({ token }: { token: string }) {
  return (
    <form action={verifyPortalMagicLinkAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <button
        type="submit"
        className="self-start px-8 py-4 text-[14px] font-medium uppercase"
        style={{
          backgroundColor: "#0A0A0A",
          color: "#FAFAF7",
          letterSpacing: "0.1em",
        }}
      >
        Continue to portal
      </button>
    </form>
  );
}
