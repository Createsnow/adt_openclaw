# xA Gateway 镜像：官方 OpenClaw + OA 桥接插件（含依赖）。
# 在仓库 linux/ 目录下构建：
#   docker build -f docker/Dockerfile -t xa-gateway-oa:2026.9.2 .
# 现网配置 bridge-config.json 不进镜像，由 compose 只读挂载到 /opt/xa/oa-workflow-bridge/bridge-config.json。
# 本机已有别的官方镜像名（如 openclaw/openclaw:latest）时：--build-arg OPENCLAW_IMAGE=<那个名字>
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.2
FROM ${OPENCLAW_IMAGE}

USER root
# 国内拉 npm 慢时：--build-arg npm_config_registry=https://registry.npmmirror.com
ARG npm_config_registry
COPY OA_tool/oa-workflow-bridge /opt/xa/oa-workflow-bridge
RUN cd /opt/xa/oa-workflow-bridge \
 && rm -rf node_modules tests bridge-config.json \
 && npm ci --omit=dev --no-audit --no-fund \
 && chown -R 1000:1000 /opt/xa
USER 1000:1000
