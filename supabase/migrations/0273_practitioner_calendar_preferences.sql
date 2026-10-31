-- 0273 / WS-F (SETTINGS-REDESIGN-PLAN): true PER-USER calendar display
-- preferences, practitioner-scoped.
--
-- DRAFT, HELD, PREPARE-ONLY. Additive: one table, one command. No backfill, no
-- change to any existing table, column, function or policy, and nothing is
-- applied without Sam's per-change approval. Reservation: OPS, 0273.
--
-- WHAT EXISTS TODAY. Time format (0109 studios.time_format_preference) and the
-- birthday reminder colour (0040 studios.birthday_reminder_color) are
-- STUDIO-WIDE and stay so: this file changes neither, and the owner-only
-- studio controls keep their meaning. There was no storage at all for a default
-- calendar view or a birthday display choice. This adds the PERSONAL layer.
--
-- WHAT THIS ADDS. One row per practitioner (at most) holding four OPTIONAL
-- overrides. NULL in any column means "no personal choice: use the studio
-- value", so a practitioner who never opens the page changes nothing for anyone
-- and a cleared choice falls back rather than hard-coding a copy of the studio
-- setting.
--     time_format_override   '12h' | '24h'
--     default_calendar_view  'day' | 'week' | 'month'   (the application still
--                            decides whether a Day view exists for the studio;
--                            this stores a wish, never an entitlement)
--     birthday_display       'show' | 'hide'            (birthday reminders on
--                            this person's own calendar)
--     birthday_color         the same five tokens as studios.birthday_reminder_color
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON practitioners. practitioners is readable
-- by every member of the studio (that is how a team calendar shows names and
-- colours). A personal preference is nobody else's business, so it lives in its
-- own table whose ONLY policy is "the row is mine": a colleague, the owner and
-- every other studio read zero rows. The owner has no read path to a
-- practitioner's personal preferences by design.
--
-- THE ONLY WRITER IS A GOVERNED COMMAND, set_own_calendar_preferences. The actor
-- is ALWAYS auth.uid(), resolved to the ACTIVE practitioner in ONE explicit
-- studio by 0178's own_practitioner_in_studio. The caller supplies a studio and
-- a patch, never a practitioner id, so there is nothing to forge. No API role
-- holds INSERT, UPDATE or DELETE on the table, and there is no write policy.
--
-- PATCH SEMANTICS. A key that is present is applied; a JSON null CLEARS that
-- choice back to the studio value; an absent key is left alone. The key set is
-- CLOSED: an unknown key is refused, so no future column becomes writable by
-- accident and a typo is an error rather than a silent no-op. An empty patch is
-- refused. Returns the practitioner id, or NULL when the caller has no active
-- membership in that studio (never a success for a zero-row write).
--
-- WHAT THIS DOES NOT DO. It does not let a practitioner change a studio-wide
-- value, does not write studios, and enforces nothing about the owner-only
-- studio controls (that is the application's and WS-D's). It is not audited:
-- these are a person's own display choices, not studio records or clinical data.
-- It grants service_role nothing: no server path needs to read or write a
-- personal preference on someone's behalf.
begin;
set local lock_timeout = '5s';

create table public.practitioner_calendar_preferences (
  practitioner_id uuid primary key,
  studio_id uuid not null,
  time_format_override text
    check (time_format_override is null or time_format_override in ('12h', '24h')),
  default_calendar_view text
    check (default_calendar_view is null or default_calendar_view in ('day', 'week', 'month')),
  birthday_display text
    check (birthday_display is null or birthday_display in ('show', 'hide')),
  birthday_color text
    check (birthday_color is null
           or birthday_color in ('purple', 'orange', 'blue', 'green', 'neutral')),
  updated_at timestamptz not null default now()
);

-- 0179's law: a reference to a practitioner is composite and same-studio, so a
-- row can never claim a studio its practitioner is not in. The preference goes
-- with the practitioner (and with the studio, through the practitioner).
alter table public.practitioner_calendar_preferences
  add constraint practitioner_calendar_preferences_practitioner_same_studio_fk
  foreign key (practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete cascade;

comment on table public.practitioner_calendar_preferences is
  '0273. A practitioner''s OWN optional calendar display overrides (time format, default view, birthday display and colour). NULL = use the studio value. Readable only by the owner of the row; written only by set_own_calendar_preferences. Not clinical, not audited.';

alter table public.practitioner_calendar_preferences enable row level security;

-- "The row is mine". The helper from 0178 is NOT used here: its EXECUTE is
-- granted to nobody, and a policy expression runs with the caller's rights.
create policy "practitioner_calendar_preferences_own_select"
  on public.practitioner_calendar_preferences for select to authenticated
  using (
    exists (
      select 1
        from public.practitioners p
       where p.id = practitioner_calendar_preferences.practitioner_id
         and p.studio_id = practitioner_calendar_preferences.studio_id
         and p.user_id = (select auth.uid())
         and p.active = true
    )
  );

revoke all on public.practitioner_calendar_preferences from public;
revoke all on public.practitioner_calendar_preferences from anon;
revoke all on public.practitioner_calendar_preferences from authenticated;
revoke all on public.practitioner_calendar_preferences from service_role;
grant select on public.practitioner_calendar_preferences to authenticated;

create or replace function public.set_own_calendar_preferences(
  p_studio_id uuid,
  -- { "time_format": "12h"|"24h"|null, "default_view": "day"|"week"|"month"|null,
  --   "birthday_display": "show"|"hide"|null, "birthday_color": <token>|null }
  p_patch jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
  v_key text;
  v_val jsonb;
  v_cur public.practitioner_calendar_preferences%rowtype;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or not exists (select 1 from jsonb_object_keys(p_patch)) then
    raise exception 'Give at least one calendar preference to change.'
      using errcode = 'check_violation';
  end if;

  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  -- Closed key set, and each value is a string from its own closed set or a
  -- JSON null. Validated before anything is written.
  for v_key, v_val in select * from jsonb_each(p_patch) loop
    if v_key not in ('time_format', 'default_view', 'birthday_display', 'birthday_color') then
      raise exception 'Unknown calendar preference.' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(v_val) = 'null' then
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'string'
       or not (
         (v_key = 'time_format' and (v_val #>> '{}') in ('12h', '24h'))
         or (v_key = 'default_view' and (v_val #>> '{}') in ('day', 'week', 'month'))
         or (v_key = 'birthday_display' and (v_val #>> '{}') in ('show', 'hide'))
         or (v_key = 'birthday_color'
             and (v_val #>> '{}') in ('purple', 'orange', 'blue', 'green', 'neutral'))
       ) then
      raise exception 'Unsupported value for that calendar preference.'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- Ensure the row, then lock it, so two concurrent patches to different keys
  -- merge rather than the later one overwriting the earlier with stale values.
  insert into public.practitioner_calendar_preferences (practitioner_id, studio_id)
  values (v_pract, p_studio_id)
  on conflict (practitioner_id) do nothing;

  select * into v_cur
    from public.practitioner_calendar_preferences x
   where x.practitioner_id = v_pract
     for update;

  update public.practitioner_calendar_preferences x
     set time_format_override = case when p_patch ? 'time_format'
           then p_patch ->> 'time_format' else v_cur.time_format_override end,
         default_calendar_view = case when p_patch ? 'default_view'
           then p_patch ->> 'default_view' else v_cur.default_calendar_view end,
         birthday_display = case when p_patch ? 'birthday_display'
           then p_patch ->> 'birthday_display' else v_cur.birthday_display end,
         birthday_color = case when p_patch ? 'birthday_color'
           then p_patch ->> 'birthday_color' else v_cur.birthday_color end,
         updated_at = now()
   where x.practitioner_id = v_pract;

  return v_pract;
end;
$$;

comment on function public.set_own_calendar_preferences(uuid, jsonb) is
  '0273. A practitioner sets their OWN calendar display preferences in one explicit studio. Actor is auth.uid(); no practitioner id crosses the boundary. A present key is applied, a JSON null clears it to the studio value, an absent key is untouched; the key set is closed. Returns NULL when the caller has no active membership in that studio.';

revoke execute on function public.set_own_calendar_preferences(uuid, jsonb) from public;
revoke execute on function public.set_own_calendar_preferences(uuid, jsonb) from anon;
revoke execute on function public.set_own_calendar_preferences(uuid, jsonb) from authenticated;
revoke execute on function public.set_own_calendar_preferences(uuid, jsonb) from service_role;
grant execute on function public.set_own_calendar_preferences(uuid, jsonb) to authenticated;

commit;
