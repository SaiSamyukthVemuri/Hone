-- S0B (P4) PRE-RESTORE: vault secrets. Run only if p0 says vault.secrets exists. COUNT ONLY: no name, no value, no id.
select count(*) as secrets from vault.secrets;
