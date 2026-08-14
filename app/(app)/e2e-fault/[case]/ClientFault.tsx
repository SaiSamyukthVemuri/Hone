"use client";

import { useEffect, useState } from "react";

// Throws in the BROWSER, after hydration, never during the server render.
//
// That distinction is the whole point. In a production build React replaces a
// server error's message with a fixed placeholder before it crosses to the
// client, so a test that only injects a server throw can never tell a boundary
// that withholds the message from one that renders it: both show the same
// harmless text. This component makes the real message present in the browser,
// which turns the leak assertion into a real one.
//
// It is also the only way to reach the digest-ABSENT branch of the reference
// UI: Next always assigns a digest to a server error, and never to one raised
// in the browser.
//
// The server render must succeed, or this would be a server error again, so the
// throw is armed by an effect rather than thrown on first render.
//
// The message arrives as a PROP rather than being imported. The constant lives
// in the server-only guard module (which a client component may not import),
// and keeping it there also means the canary text is never compiled into the
// production client bundle: it reaches the browser only on the guarded local
// route, which 404s everywhere else.
export function ClientFault({ message }: { message: string }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(true);
  }, []);

  if (armed) {
    throw new Error(message);
  }

  return <p data-testid="client-fault-arming">arming</p>;
}
