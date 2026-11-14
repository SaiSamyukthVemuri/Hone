-- 0332 — ROLES: the activation-preview fingerprint includes the operator ship gates (Codex P2 on #1340, 0287 line 1092).
--
-- 0287 is APPLIED on hosted and its bytes are frozen. This migration corrects one helper by `create or replace`, nothing else: no table,
-- column, policy, index, trigger or data is touched, and 0331 is not edited.
--
-- The defect: perm_activation_hash fingerprints each key's release, the studio's stored choices and the studio basis, but NOT the operator ship
-- gates that cap a key's effective scope (permission_ship_gates, for example receptionist_scheduling_notes for appt.edit_notes). An operator
-- flipping a gate between the owner's preview and the owner's commit therefore left the old preview accepted, although what the commit would
-- change was no longer what the owner was shown. The fingerprint now carries, for each key, the state of each gate that key names (absent = not
-- met, the same fail-closed reading the resolver uses), so a gate flipped after the preview makes the commit refuse as stale_preview.
--
-- Consequence: every fingerprint computed before this migration differs from one computed after it, so a preview held open across the apply is
-- reported stale and the owner previews again. Nothing else changes.
--
-- Grants: an internal helper. 0287 revoked it from public, anon, authenticated and service_role and granted nothing back; `create or replace`
-- keeps that ACL, and the revoke below restates it by name.
begin;
set local lock_timeout = '5s';

create or replace function public.perm_activation_hash(p_studio uuid, p_keys text[])
returns text language sql stable security definer set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(string_agg(t.x, '|' order by t.x), ''), 'UTF8')), 'hex')
    from (
      select r.key || ':' || r.release_tag || ':' || r.release_kind || ':' || coalesce(r.released_at::text, 'pending') || ':'
             || coalesce((select string_agg(s.role || '=' || s.scope || '@' || s.set_at::text, ',' order by s.role)
                            from public.studio_role_permissions s where s.studio_id = p_studio and s.key = r.key), '') || ':'
             || coalesce((select spp.basis || '@' || spp.basis_at::text from public.studio_permission_policy spp where spp.studio_id = p_studio), '') || ':'
             || coalesce((select string_agg(gt.gate || '=' || coalesce((select g.met from public.permission_ship_gates g
                                                                          where g.studio_id = p_studio and g.gate = gt.gate), false)::text, ',' order by gt.gate)
                            from (select distinct u.gate
                                    from public.permission_catalog c, lateral unnest(array[c.gate_practitioner, c.gate_receptionist]) as u(gate)
                                   where c.key = r.key and u.gate is not null) gt), '') as x
        from public.permission_key_release r where r.key = any (p_keys)
    ) t
$$;

revoke all on function public.perm_activation_hash(uuid, text[]) from public, anon, authenticated, service_role;

commit;
