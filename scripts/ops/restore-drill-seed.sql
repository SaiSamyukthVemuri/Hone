-- HIPAA-READY-01 G-12: synthetic rows for scripts/ops/restore-drill.sh.
-- Every value is synthetic. The fixed ids let the drill script build Storage
-- paths that satisfy treatment_images' path check (studio/client/name.ext).
begin;

insert into public.studios (id, name, owner_email)
values ('d0d0d0d0-0000-4000-8000-000000000001', 'Restore Drill Synthetic Studio', 'owner@restore-drill.invalid');

insert into public.practitioners (id, studio_id, display_name, email, role)
values ('d0d0d0d0-0000-4000-8000-000000000003', 'd0d0d0d0-0000-4000-8000-000000000001',
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
