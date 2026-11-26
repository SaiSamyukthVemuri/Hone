"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function PaymentConfirmation() {
  const router = useRouter();
  useEffect(() => {
    let delay = 1500;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      if (document.visibilityState === "visible") router.refresh();
      delay = Math.min(15000, delay * 2);
      timer = setTimeout(check, delay);
    }
    timer = setTimeout(check, delay);
    return () => clearTimeout(timer);
  }, [router]);
  return (
    <button className="underline" onClick={() => router.refresh()}>
      Check payment status
    </button>
  );
}
