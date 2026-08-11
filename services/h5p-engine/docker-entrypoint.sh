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

exec "$@"
