#!/bin/bash
# Pide el token de Cloudflare con entrada oculta, lo verifica contra la API
# y solo entonces lo guarda en .cf-token.
# No lo imprime, no toca el portapapeles y no queda en el historial del shell.
set -uo pipefail
cd "$(dirname "$0")"

printf 'Pega el API token de Cloudflare (no se vera nada al pegarlo) y pulsa Enter:\n> '
IFS= read -rs TOKEN
printf '\n'

TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [ -z "$TOKEN" ]; then
  echo "No has pegado nada. Vuelve a lanzarlo."
  exit 1
fi

echo "Verificando contra Cloudflare..."
RESP="$(curl -s -X GET 'https://api.cloudflare.com/client/v4/user/tokens/verify' \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')"

if printf '%s' "$RESP" | grep -q '"success":true'; then
  umask 077
  printf '%s' "$TOKEN" > .cf-token
  chmod 600 .cf-token
  unset TOKEN
  echo
  echo "Token valido y activo. Guardado en .cf-token (permisos 600, ignorado por git)."
  echo "Listo: dile a Claude que ya puede desplegar."
else
  unset TOKEN
  echo
  echo "Cloudflare ha rechazado ese token. No he guardado nada."
  echo "Respuesta de la API:"
  printf '%s\n' "$RESP" | sed -E 's/"[A-Za-z0-9_-]{25,}"/"<oculto>"/g'
  echo
  echo "Revisa que copiaste solo el token, sin comillas ni el 'Bearer ' delante."
  exit 1
fi
