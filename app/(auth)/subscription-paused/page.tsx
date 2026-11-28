import { listActiveStudioMemberships } from "@/lib/supabase/queries";
import Link from "next/link";
import { signOutFromGate } from "../no-access/actions";

export default async function SubscriptionPausedPage({ searchParams }: { searchParams: Promise<{ desk?: string }> }) {
  const { desk } = await searchParams;
  const memberships = await listActiveStudioMemberships();
  return <main className="mx-auto max-w-md space-y-4 px-5 py-16">
    <h1 className="text-xl font-semibold">Studio access is paused</h1>
    <p>Your studio owner canceled the Hone subscription. Contact your owner about access.</p>
    {desk === "choose" && <Link className="underline" href="/desk/choose">Choose another front desk</Link>}
    {desk && memberships.length === 1 && <Link className="underline" href="/dashboard">Open practitioner workspace</Link>}
    {memberships.length > 1 && <Link className="underline" href="/no-access?reason=multiple-studios">Choose another studio</Link>}
    <form action={signOutFromGate}><button className="underline">Sign out</button></form>
  </main>;
}
