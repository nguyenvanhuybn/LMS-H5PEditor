#!/bin/sh
# Restore the H5P library bundle captured from the local authoring instance.
# This only replaces library folders. It never touches /data/h5p/content.
set -eu

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lms-h5p}"
H5P_DATA_VOLUME="${H5P_DATA_VOLUME:-${PROJECT_NAME}_h5p-data}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUNDLE_PATH="$SCRIPT_DIR/assets/h5p-libraries-localhost-20260810.tar.gz"
CHECKSUM_PATH="$SCRIPT_DIR/assets/h5p-libraries-localhost-20260810.sha256"

if [ ! -f "$BUNDLE_PATH" ] || [ ! -f "$CHECKSUM_PATH" ]; then
  echo "H5P library bundle or checksum file is missing."
  exit 1
fi

if ! docker volume inspect "$H5P_DATA_VOLUME" >/dev/null 2>&1; then
  echo "H5P Docker volume '$H5P_DATA_VOLUME' was not found. Start the stack first."
  exit 1
fi

expected_checksum="$(awk '{ print $1 }' "$CHECKSUM_PATH")"
actual_checksum="$(sha256sum "$BUNDLE_PATH" | awk '{ print $1 }')"
if [ "$expected_checksum" != "$actual_checksum" ]; then
  echo "Bundle checksum does not match; restore cancelled."
  exit 1
fi

backup_name="localhost-20260810-$(date +%Y%m%d%H%M%S)"
echo "Restoring H5P libraries into volume: $H5P_DATA_VOLUME"
echo "Existing matching library folders will be retained under: library-backups/$backup_name"

docker run --rm --interactive \
  --volume "$H5P_DATA_VOLUME:/target" \
  --volume "$BUNDLE_PATH:/bundle/h5p-libraries.tar.gz:ro" \
  alpine:3.20 \
  sh -s -- "$backup_name" <<'CONTAINER_SCRIPT'
set -eu

backup_name="$1"
stage_dir="/target/.library-bundle-staging"
backup_dir="/target/library-backups/$backup_name"

rm -rf "$stage_dir"
mkdir -p "$stage_dir" "$backup_dir" /target/libraries
tar -xzf /bundle/h5p-libraries.tar.gz -C "$stage_dir"

for library_dir in "$stage_dir"/*; do
  [ -d "$library_dir" ] || continue
  [ -f "$library_dir/library.json" ] || continue

  library_name="$(basename "$library_dir")"
  destination="/target/libraries/$library_name"
  if [ -e "$destination" ]; then
    mv "$destination" "$backup_dir/$library_name"
  fi
  mv "$library_dir" "$destination"
  echo "Restored $library_name"
done

rm -rf "$stage_dir"
CONTAINER_SCRIPT

echo "Restore completed. Restart h5p-engine before opening the editor."
