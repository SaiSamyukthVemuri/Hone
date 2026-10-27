-- S0B (P7) foreign servers: a restored copy could reach out through a foreign data wrapper. Count only.
select (select count(*) from pg_foreign_server) as foreign_servers;
