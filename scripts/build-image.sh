#!/usr/bin/env bash
# Build the isolated executor/judge image used for every benchmark run.
set -euo pipefail

IMAGE_NAME="${BENCH_IMAGE:-claude-bench:latest}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building ${IMAGE_NAME} from ${REPO_ROOT}/Dockerfile ..."
docker build -t "${IMAGE_NAME}" "${REPO_ROOT}"
echo "Done. Image: ${IMAGE_NAME}"
