#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on your host." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
mkdir -p data
chmod 700 data
if [ ! -f config.json ]; then
  printf '{}\n' > config.json
  chmod 600 config.json
fi
if [ ! -f .env ]; then
  if command -v openssl >/dev/null 2>&1; then
    KEY="$(openssl rand -hex 32)"
  elif command -v python3 >/dev/null 2>&1; then
    KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  else
    echo "openssl or python3 is required to create a secure key." >&2
    exit 1
  fi
  # Pure hex key is safe for this replacement and is not logged.
  sed "s/^CHATGPT2API_AUTH_KEY=.*/CHATGPT2API_AUTH_KEY=$KEY/" .env.example > .env
  chmod 600 .env
  echo "Created .env and random authentication key (not printed)."
else
  echo "Existing .env retained. No secrets overwritten."
fi
echo "Start locally: docker compose up -d app"
echo "Check: python3 scripts/smoke_test.py --base-url http://127.0.0.1:3000"
