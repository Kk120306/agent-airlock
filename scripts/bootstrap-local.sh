#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -L .env ]]; then
  echo "Refusing to use a symlinked .env file." >&2
  exit 1
fi

if [[ ! -e .env ]]; then
  (set -o noclobber; : > .env)
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example."
fi

env_mode=""
if env_mode="$(stat -c '%a' .env 2>/dev/null)"; then
  :
elif env_mode="$(stat -f '%Lp' .env 2>/dev/null)"; then
  :
else
  echo "Could not verify .env permissions on this host." >&2
  exit 1
fi
if [[ "$env_mode" != "600" ]]; then
  echo ".env must have mode 600; run: chmod 600 .env" >&2
  exit 1
fi

host_uid="$(id -u)"
host_gid="$(id -g)"
if [[ "$host_uid" == "0" || "$host_gid" == "0" ]]; then
  echo "Local Compose bootstrap requires a non-root host UID and GID." >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*CONTAINER_USER[[:space:]]*=' .env; then
  printf '\nCONTAINER_USER=%s:%s\n' "$host_uid" "$host_gid" >> .env
  echo "Configured the Compose container for host UID:GID $host_uid:$host_gid."
fi

container_user="$(sed -n 's/^[[:space:]]*CONTAINER_USER[[:space:]]*=[[:space:]]*//p' .env | tail -n 1)"
if [[ ! "$container_user" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
  echo "CONTAINER_USER must be a non-root numeric UID:GID." >&2
  exit 1
fi

mkdir -p data workspaces codex-home

echo "Next:"
echo "  1. Fill APP_AUTH_TOKEN, ARK_API_KEY, and ARK_MODEL in .env"
echo "  2. Run: docker compose up --build"
