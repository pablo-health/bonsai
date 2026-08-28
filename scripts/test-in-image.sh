#!/usr/bin/env bash
#
# Runs the unit suite inside the built image, which is the only place it currently runs at all.
#
# WHY THIS EXISTS. `isolated-vm` ships prebuilds up to Node ABI 137 (Node 24). A developer machine
# on Node 26 is ABI 147, so `npm run test:unit` dies at import with "No native build was found"
# before a single test executes - and it takes most of the suite with it, because the runner loads
# every file. The failure looks like a broken machine rather than a suite that has not run, so it
# gets stepped around.
#
# What that cost, discovered on 2026-08-28: `responseGenerator.test.ts` had been red since commit
# b353922 changed the filler prefill to drop its trailing full stop. Nobody saw it for a day,
# because nobody could run the suite outside CI.
#
# The image carries the right prebuild and every dependency, but the Dockerfile does NOT copy
# `tests/` - so the tests are mounted over it and run against the image's own `src/`. That means
# this checks the code AS BUILT, which is a feature: it is the same tree the box is serving.
#
# Usage, from a checkout on any host that has the image:
#   scripts/test-in-image.sh                              # whole unit suite
#   scripts/test-in-image.sh tests/unit/live/foo.test.ts  # one file
#
# A handful of tests reach for a real database. Set DB_FROM_CONTAINER to the name of a running
# Bonsai container and its connection settings are borrowed for the run:
#   DB_FROM_CONTAINER=bonsai-bonsai-1 scripts/test-in-image.sh
set -euo pipefail

IMAGE="${IMAGE:-bonsai:livekit}"
here="$(cd "$(dirname "$0")/.." && pwd)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "No such image: $IMAGE. Build it first, or set IMAGE=..." >&2
  exit 1
fi

env_args=()
env_file=""
if [ -n "${DB_FROM_CONTAINER:-}" ]; then
  # Written to a private file rather than passed as -e, so the connection string never appears in
  # the process list or in this script's own output.
  env_file="$(mktemp)"
  chmod 600 "$env_file"
  trap 'rm -f "$env_file"' EXIT
  docker inspect "$DB_FROM_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -E '^(DATABASE_URL|JWT_SECRET|MASTER_ENCRYPTION_KEY)=' > "$env_file"
  env_args=(--env-file "$env_file")
fi

if [ $# -gt 0 ]; then
  command="node_modules/.bin/mocha --require tsx $*"
else
  command="node_modules/.bin/tsx tests/unit/runner.ts"
fi

docker run --rm --network host "${env_args[@]}" \
  -v "$here/tests:/app/tests:ro" \
  -e AWS_REGION="${AWS_REGION:-us-east-1}" \
  --entrypoint sh "$IMAGE" -c "$command"
