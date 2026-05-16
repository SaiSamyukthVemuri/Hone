# Hone

Charting software for independent electrologists and laser hair removal practitioners.

Built by [Saltkiln](https://saltkiln.com). Anchor customer: Belleville Electrolysis Studio.

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **Supabase** — Postgres, Auth (magic link), Storage
- **Vercel** — hosting at `hone.studio`

## Local setup

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev
```

The app starts on http://localhost:3000.

## Supabase setup

1. Create a new project at <https://supabase.com/dashboard>.
2. In **Project Settings → API**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. In **Authentication → URL Configuration**, set:
   - **Site URL**: `http://localhost:3000` (dev) and later `https://hone.studio`
   - **Redirect URLs**: add `http://localhost:3000/auth/callback` and `https://hone.studio/auth/callback`
4. In **Authentication → Providers → Email**, enable **Magic Link**. Disable signups via password.
5. Apply the schema. Easiest path:
   - Open the SQL editor in the Supabase dashboard.
   - Paste the contents of `supabase/migrations/0001_init.sql` and run it.
   - Or, with the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) linked to the project: `supabase db push`.
6. Seed the first studio + owner practitioner manually (one-time). In the SQL editor:

   ```sql
   -- 1. Create the studio.
   insert into studios (name, owner_email)
   values ('Belleville Electrolysis Studio', 'theresa@example.com')
   returning id;
   -- copy the returned id

   -- 2. Have the owner sign in once via magic link so an auth.users row exists,
   --    then look up their user id:
   select id, email from auth.users where email = 'theresa@example.com';

   -- 3. Link them as the owner practitioner:
   insert into practitioners (studio_id, user_id, display_name, email, role)
   values (
     '<studio-id-from-step-1>',
     '<user-id-from-step-2>',
     'Theresa Newman',
     'theresa@example.com',
     'owner'
   );
   ```

## Vercel setup

1. Push this repo to GitHub.
2. Import the project on Vercel and pick the Next.js preset.
3. Add the two environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) to **Production**, **Preview**, and **Development**.
4. Once deployed, point `hone.studio` at the Vercel project.
5. Add `https://hone.studio/auth/callback` to Supabase Auth redirect URLs (step 3 above).

## Project layout

```
app/
  (auth)/
    login/           magic-link sign-in form
    auth/callback/   code → session exchange
  (app)/
    dashboard/       protected placeholder home
  page.tsx           public landing
  layout.tsx
  globals.css        Tailwind v4 entrypoint
components/          shared UI (empty for now)
lib/
  supabase/
    client.ts        createBrowserClient — use in client components
    server.ts        createServerClient — use in server components / actions / route handlers
    middleware.ts    session refresh + redirect-when-signed-out
  types/
    database.ts      hand-rolled row types (regenerate later via supabase gen types)
supabase/
  migrations/
    0001_init.sql    schema + RLS policies
middleware.ts        wires lib/supabase/middleware into Next.js
```

## Multi-tenancy

Every domain table has a `studio_id` and an RLS policy that delegates to
`public.is_studio_member(studio_id)` (or `is_studio_owner(...)` for sensitive
writes). The helper checks whether the current `auth.uid()` has an active
`practitioners` row in that studio. Per-entry tables that don't carry
`studio_id` themselves (`electrolysis_entries`, `laser_entries`) go through
`session_is_visible(session_id)` instead.

## Next steps

The six v1 screens, in order:
1. Today's roster
2. Client cheat sheet (the killer flow)
3. Log session (with copy-last-session)
4. Client list + new client
5. Settings (practitioners, probe lots, areas, pricing)
6. PDF export
