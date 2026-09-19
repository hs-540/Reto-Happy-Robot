#!/bin/bash
# Prompts for the Cloudflare API token with hidden input, verifies it against
# the API and only then writes it to .cf-token.
# It is never printed, never touches the clipboard and never reaches the shell
# history.
set -uo pipefail
cd "$(dirname "$0")"

printf 'Paste your Cloudflare API token (nothing will show as you paste) and press Enter:\n> '
IFS= read -rs TOKEN
printf '\n'

TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [ -z "$TOKEN" ]; then
  echo "Nothing pasted. Run it again."
  exit 1
fi

echo "Verifying against Cloudflare..."
RESP="$(curl -s -X GET 'https://api.cloudflare.com/client/v4/user/tokens/verify' \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')"

if printf '%s' "$RESP" | grep -q '"success":true'; then
  umask 077
  printf '%s' "$TOKEN" > .cf-token
  chmod 600 .cf-token
  unset TOKEN
  echo
  echo "Token valid and active. Saved to .cf-token (mode 600, git-ignored)."
else
  unset TOKEN
  echo
  echo "Cloudflare rejected that token. Nothing was saved."
  echo "API response:"
  printf '%s\n' "$RESP" | sed -E 's/"[A-Za-z0-9_-]{25,}"/"<hidden>"/g'
  echo
  echo "Check that you copied only the token, with no quotes and no 'Bearer ' prefix."
  exit 1
fi
