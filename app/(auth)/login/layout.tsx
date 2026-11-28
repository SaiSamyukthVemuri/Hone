import Link from "next/link";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {isSelfServeCheckoutEnabled(process.env) && (
        <nav
          aria-label="Subscriber sign-in"
          className="border-b border-line p-3 text-center text-sm"
        >
          Already subscribe to Hone?{" "}
          <Link href="/signup?returning=1" className="underline">
            Open your studio
          </Link>
        </nav>
      )}
      {children}
    </>
  );
}
