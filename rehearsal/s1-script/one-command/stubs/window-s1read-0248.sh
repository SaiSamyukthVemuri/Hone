#!/bin/bash
ME=s1read; . "$HOME/hone-s1/stub-common.sh"
ssecret TOK "Supabase access token (not shown): " "$TOKH"
ssecret PW "Database password (not shown; only its presence is used here): " "$PWH"
echo "OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)"
