import { Button, buttonClasses } from "@/components/ui/button";
import { portalLogoutAction } from "./logout/actions";

export function PortalIdentityUnavailable({ temporary }: { temporary: boolean }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-6">
      <h1 className="font-[var(--font-fraunces)] text-3xl">
        {temporary ? "We couldn’t load your portal." : "This portal is unavailable."}
      </h1>
      <p>{temporary ? "Try again in a moment." : "Please contact your studio if you still need access."}</p>
      <div className="flex flex-wrap gap-3">
        <a className={buttonClasses({ variant: "primary" })} href="/portal">Try again</a>
        <form action={portalLogoutAction}><Button type="submit">Sign out</Button></form>
      </div>
    </main>
  );
}
