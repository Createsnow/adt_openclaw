#!/bin/sh
set -eu
for secret in \
  gateway_token \
  wecom_bot_id \
  wecom_bot_secret \
  model_api_key \
  model_base_url \
  model_id \
  model_ref \
  oa_mysql_password \
  oa_api_user_id \
  oa_app_secret \
  wecom_identity_corpid \
  wecom_identity_secret
do
  path="/run/secrets/$secret"
  if [ ! -s "$path" ]; then
    echo "missing or empty secret: $path" >&2
    exit 1
  fi
done

# gateway token凭据
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"

export OPENCLAW_STATE_DIR="/home/node/.openclaw"

# 模型凭据（api 协议写死在 openclaw.json，不再注入 XA_DOMESTIC_API）
export XA_DOMESTIC_API_KEY="$(tr -d '\n' < /run/secrets/model_api_key)"
export XA_DOMESTIC_BASE_URL="$(tr -d '\n' < /run/secrets/model_base_url)"
export XA_DOMESTIC_MODEL_ID="$(tr -d '\n' < /run/secrets/model_id)"
export XA_DOMESTIC_MODEL_REF="$(tr -d '\n' < /run/secrets/model_ref)"

# 企微机器人访问凭据
export XA_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"

# 企业微信访问凭据
export WECOM_IDENTITY_CORPID="$(tr -d '\n' < /run/secrets/wecom_identity_corpid)"
export WECOM_IDENTITY_SECRET="$(tr -d '\n' < /run/secrets/wecom_identity_secret)"

# OA 桥接数据库（独立 MySQL）密码；主机 / 库名 / 账号在 bridge-config.json 的 mysql 段
export OA_MYSQL_PASSWORD="$(tr -d '\n' < /run/secrets/oa_mysql_password)"

# OA系统开门凭据
export OA_API_USER_ID="$(tr -d '\n' < /run/secrets/oa_api_user_id)"
export OA_APP_SECRET="$(tr -d '\n' < /run/secrets/oa_app_secret)"

exec node dist/index.js gateway --bind lan --port 18789
