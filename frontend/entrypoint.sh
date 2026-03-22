#!/bin/sh
set -eu

cat >/usr/share/nginx/html/config.js <<EOF_JS
window.__APP_CONFIG__ = {
  backendUrl: '${COIL_BACKEND_URL:-}'
};
EOF_JS

exec "$@"
