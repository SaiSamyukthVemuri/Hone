-- HIPAA-READY-01 G-12: synthetic rows for scripts/ops/restore-drill.sh.
-- Every value is synthetic. The fixed ids let the drill script build Storage
-- paths that satisfy treatment_images' path check (studio/client/name.ext).
begin;

-- A synthetic auth user with a Google identity, so the drill proves the
-- provider-to-user mapping survives (auth.identities), not just auth.users.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', 'd0d0d0d0-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
        'practitioner@restore-drill.invalid', now(), now(),
        '{"provider":"google","providers":["google"]}', '{}');

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('synthetic-google-sub-restore-drill', 'd0d0d0d0-0000-4000-8000-000000000004',
        '{"sub":"synthetic-google-sub-restore-drill","email":"practitioner@restore-drill.invalid"}',
        'google', now(), now());

insert into public.studios (id, name, owner_email)
values ('d0d0d0d0-0000-4000-8000-000000000001', 'Restore Drill Synthetic Studio', 'owner@restore-drill.invalid');

insert into public.practitioners (id, studio_id, user_id, display_name, email, role)
values ('d0d0d0d0-0000-4000-8000-000000000003', 'd0d0d0d0-0000-4000-8000-000000000001',
        'd0d0d0d0-0000-4000-8000-000000000004',
        'Synthetic Practitioner', 'practitioner@restore-drill.invalid', 'owner');

insert into public.clients (id, studio_id, name)
values ('d0d0d0d0-0000-4000-8000-000000000002', 'd0d0d0d0-0000-4000-8000-000000000001',
        'Synthetic Client Restore-Drill');

insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body)
values ('d0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-000000000002',
        'd0d0d0d0-0000-4000-8000-000000000003', 'consultation',
        'SYNTHETIC restore-drill note. Not a real person.');

insert into public.treatment_images (studio_id, client_id, storage_path, content_type, size_bytes)
select 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-000000000002',
       format('d0d0d0d0-0000-4000-8000-000000000001/d0d0d0d0-0000-4000-8000-000000000002/synthetic-%s.png', i),
       'image/png', 4096 * i
from generate_series(1, 3) as i;

commit;
