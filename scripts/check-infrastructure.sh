#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet

if command -v terraform >/dev/null 2>&1; then
  terraform fmt -check -recursive deploy/volcengine
elif docker image inspect hashicorp/terraform:1.12 >/dev/null 2>&1; then
  docker run --rm \
    -v "$PROJECT_ROOT:/work" \
    -w /work \
    hashicorp/terraform:1.12 \
    fmt -check -recursive deploy/volcengine
else
  echo "Terraform CLI or the pinned hashicorp/terraform:1.12 image is required." >&2
  exit 1
fi
