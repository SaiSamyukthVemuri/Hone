#!/bin/bash
ME=s0a; . "$HOME/hone-s1/stub-common.sh"
sask OPERATOR "Operator label (your initials or a short label, no names of customers): " "$X_OPERATOR"
sask WSTART "Window start (UTC): " "$X_WSTART"
sask WEND "Window end (UTC): " "$X_WEND"
sask H1 "Cron-job.org reminders paused: " yes
sask H2 "People hold in place (no archive/export/charges/manual fee/portal card setup): " yes
sask MFLAG "Maintenance flag decision (no_flag or flag_on): " "$X_MFLAG"
sask PITR_ON "PITR enabled on the dashboard (type exactly true): " true
sask PITR_RET "PITR retention in days (a whole number, no unit): " "$X_PITR_RET"
sask P_EARLY "Earliest recovery point on the dashboard (UTC): "
sask P_LATE "Latest recovery point on the dashboard (UTC): "
sask USEIDLE "Use the idle proof (yes or no): " no
sask R6CHOICE "R-6 choice (S0b or accept_rpo): " "$X_R6CHOICE"
sask R6ACK "Type exactly: base backup unverified, restore not tested: " "base backup unverified, restore not tested"
sask R6TEXT "R-6 answer (your words, one line): " "$X_R6TEXT"
sask R6REF "R-6 decision reference: " "$X_R6REF"
ssecret TOK "Supabase access token (not shown): " "$TOKH"
ssecret PW "Database password (not shown; only its presence is used here): " "$PWH"
echo "OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)"
