#!/usr/bin/env bash
# ONE-TIME token setup. `claude setup-token` PRINTS a long-lived subscription
# token to the terminal (it does NOT persist a credential file). This script
# runs it interactively, then stores the token you paste back into
# ./.bench-config/oauth-token (chmod 600). All benchmark runs read the token
# from there (or from the CLAUDE_CODE_OAUTH_TOKEN env var) and pass it to
# containers via an env var — no credential file is ever mounted into a container.
#
# Alternative: if CLAUDE_CODE_OAUTH_TOKEN is already exported in your shell, the
# harness uses it directly and you do NOT need to run this script.
set -euo pipefail

IMAGE_NAME="${BENCH_IMAGE:-claude-bench:latest}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${REPO_ROOT}/.bench-config"
TOKEN_FILE="${CONFIG_DIR}/oauth-token"

# 1. Ensure the image exists (auto-build if missing).
if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "Image ${IMAGE_NAME} not found — building it first."
  bash "${REPO_ROOT}/scripts/build-image.sh"
  echo
fi

# 2. Explain the flow.
cat <<'EXPLAIN'
This generates a long-lived Claude subscription token.
A browser window will open to authorize. If the browser shows a CODE instead of
redirecting back, copy that code and paste it at the "Paste code here if
prompted" prompt in this terminal.

When it finishes, the token is PRINTED in this terminal. Copy the whole token —
you will paste it back here in the next step so it can be stored securely.

EXPLAIN

# 3. Interactive token generation (NO .bench-config mount needed).
docker run -it --rm \
  -e CLAUDE_CONFIG_DIR=/cfg \
  "${IMAGE_NAME}" \
  claude setup-token

# 4. Capture the printed token and store it (never echoed back).
echo
mkdir -p "${CONFIG_DIR}"
printf 'Paste the token printed above, then press Enter: '
read -r -s TOKEN
echo
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '[:space:]')"
if [ -z "${TOKEN}" ]; then
  echo "No token entered. Aborting without writing ${TOKEN_FILE}." >&2
  exit 1
fi

printf '%s' "${TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"
unset TOKEN

echo "Token stored at ${TOKEN_FILE} (chmod 600)."
echo "You can now run: npm run bench -- --all"
