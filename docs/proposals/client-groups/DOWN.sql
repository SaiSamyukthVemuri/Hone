begin;
set local lock_timeout = '5s';
drop function public.set_client_group_membership(uuid,uuid,uuid,boolean);
drop function public.rename_client_group(uuid,uuid,text,text,timestamptz);
drop function public.create_client_group(uuid,text);
drop table public.client_group_memberships;
drop table public.client_groups;
commit;
