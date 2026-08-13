#!/bin/sh
set -eu

mkdir -p "$H5P_DATA_PATH/core" "$H5P_DATA_PATH/editor" "$H5P_DATA_PATH/content" "$H5P_DATA_PATH/libraries" "$H5P_DATA_PATH/temp"

if [ ! -f "$H5P_DATA_PATH/core/js/h5p.js" ]; then
  cp -R /opt/h5p-seed/core/. "$H5P_DATA_PATH/core/"
fi

if [ ! -f "$H5P_DATA_PATH/editor/scripts/h5peditor.js" ]; then
  cp -R /opt/h5p-seed/editor/. "$H5P_DATA_PATH/editor/"
fi

# The public H5P Hub can occasionally be unavailable. Ship one small,
# runnable content type so authors can always create content while retaining
# the normal Hub integration when it is available.
if [ ! -f "$H5P_DATA_PATH/libraries/H5P.IFrameEmbed-1.0/library.json" ]; then
  cp -R /opt/h5p-seed/libraries/H5P.IFrameEmbed-1.0 "$H5P_DATA_PATH/libraries/"
fi

# Unpack the versioned content type bundle if the image carries one. The restore
# step never downgrades a library that was updated at runtime, and it is a no-op
# once the volume already holds that version, so it is safe on every boot.
if [ -d /opt/h5p-seed/library-bundles ] && \
   [ -n "$(find /opt/h5p-seed/library-bundles -name '*.zip' -print -quit 2>/dev/null)" ]; then
  echo "Restoring H5P library bundle…"
  # A failure here must not stop the engine: the Hub remains available as a
  # fallback, and an unusable bundle should not take the whole service down.
  H5P_BUNDLE_DIR=/opt/h5p-seed/library-bundles node /app/scripts/restore-libraries.mjs \
    || echo "Library bundle restore failed; continuing with whatever is on the volume."
fi

exec "$@"
