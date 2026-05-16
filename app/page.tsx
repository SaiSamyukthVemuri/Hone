import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-6xl font-semibold tracking-tight">Hone</h1>
        <p className="text-sm text-neutral-500">
          Charting for independent electrologists.
        </p>
      </div>
      <Link
        href="/login"
        className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Sign in
      </Link>
    </main>
  );
}
