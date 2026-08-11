#!/bin/sh
# Install a reusable baseline of H5P content types without relying on H5P Hub.
#
# Run after `docker compose up -d`:
#   sh deploy/ubuntu/install-h5p-content-types.sh
#
# The libraries are downloaded from the official H5P GitHub repositories by
# h5p-cli and copied into the persistent H5P Docker volume. They therefore
# survive container recreation and can be installed identically on another
# Ubuntu environment.
set -eu

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lms-h5p}"
H5P_DATA_VOLUME="${H5P_DATA_VOLUME:-${PROJECT_NAME}_h5p-data}"
H5P_CONTENT_TYPES="${H5P_CONTENT_TYPES:-h5p-multi-choice h5p-true-false h5p-blanks}"

if ! docker volume inspect "$H5P_DATA_VOLUME" >/dev/null 2>&1; then
  echo "H5P Docker volume '$H5P_DATA_VOLUME' was not found. Start the stack first."
  exit 1
fi

echo "Installing H5P content types: $H5P_CONTENT_TYPES"
echo "Target volume: $H5P_DATA_VOLUME"

docker run --rm --interactive \
  --volume "$H5P_DATA_VOLUME:/target" \
  node:22-alpine \
  sh -s -- $H5P_CONTENT_TYPES <<'CONTAINER_SCRIPT'
set -eu

apk add --no-cache git >/dev/null
npm install --global h5p-cli >/dev/null

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

h5p core
for content_type in "$@"; do
  h5p setup "$content_type"
done

mkdir -p /target/libraries
find "$workdir/libraries" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r library_dir; do
  if [ ! -f "$library_dir/library.json" ]; then
    continue
  fi

  library_name="$(basename "$library_dir")"
  staging_dir="/target/libraries/.${library_name}.installing"
  rm -rf "$staging_dir"
  cp -R "$library_dir" "$staging_dir"
  rm -rf "/target/libraries/$library_name"
  mv "$staging_dir" "/target/libraries/$library_name"
  echo "Installed $library_name"
done
CONTAINER_SCRIPT

echo "Done. Restart the H5P engine to refresh its catalog:"
echo "docker compose --project-name $PROJECT_NAME --env-file deploy/ubuntu/.env -f deploy/ubuntu/docker-compose.yml restart h5p-engine"
