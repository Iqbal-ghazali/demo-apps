#!/bin/sh
set -e

# Codex API-key mode: if OPENAI_API_KEY is set and Codex has no login yet,
# sign in from the env var. The key is piped, never printed or passed as an argument.
if [ -n "$OPENAI_API_KEY" ] && ! codex login status >/dev/null 2>&1; then
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
fi

exec "$@"
