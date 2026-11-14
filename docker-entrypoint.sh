#!/bin/sh
set -eu

: "${HOME:=/home/node}"
export HOME
mkdir -p "${HOME}"

if [ -z "${MCP_BEARER_TOKEN:-}" ]; then
  echo "MCP_BEARER_TOKEN is required (at least 32 characters)." >&2
  exit 1
fi

# Claude gateway settings: mount settings.json at ${HOME}/.claude/settings.json,
# point WORKBENCH_CLAUDE_SETTINGS at another mounted file, or pass the env block
# inline with WORKBENCH_CLAUDE_ENV_JSON. The engine reads them; no copy needed.

# dsh headless credentials are a flat YAML file (DEEPSEEK_API_KEY,
# BAILIAN_API_KEY, ...). Generate it from a platform secret when provided.
if [ -n "${DSH_CREDENTIALS_YAML:-}" ]; then
  umask 077
  mkdir -p "${HOME}/.dsh"
  printf '%s\n' "${DSH_CREDENTIALS_YAML}" > "${HOME}/.dsh/.credentials-headless.yaml"
  chmod 600 "${HOME}/.dsh/.credentials-headless.yaml"
  unset DSH_CREDENTIALS_YAML
fi

# Optional profile patch that tells dsh which providers/models to use and where
# the headless credentials file lives.
if [ -n "${DSH_HEADLESS_PATCH_YAML:-}" ]; then
  umask 077
  mkdir -p "${HOME}/.dsh/profiles/headless"
  printf '%s\n' "${DSH_HEADLESS_PATCH_YAML}" > "${HOME}/.dsh/profiles/headless/cordis.patch.yml"
  unset DSH_HEADLESS_PATCH_YAML
fi

# Keep runtime files at normal permissions; the credential files above were
# written under umask 077.
umask 022

exec "$@"