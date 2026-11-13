#!/bin/bash
set -euo pipefail
SRC="/mnt/f/workspace/project/WSL2_Docker部署指南/docs/OA/oa-workflow-bridge-redis"
DST="/home/lijinjin/xa/extensions/oa-workflow-bridge-redis"
mkdir -p "$DST/scripts"
cp "$SRC/src/oa-client.mjs" "$DST/src/oa-client.mjs"
cp "$SRC/scripts/live-print-create.mjs" "$DST/scripts/live-print-create.mjs"
docker exec -e LIVE_OA_CREATE=1 -e OA_LOG_REQUEST_PLAINTEXT=1 -w /home/node/.openclaw/extensions/oa-workflow-bridge-redis xa-gateway sh -c '
  export OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)"
  export OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"
  node scripts/live-print-create.mjs
'
