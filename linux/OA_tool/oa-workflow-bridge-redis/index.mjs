import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBridgeConfig } from "./src/config.mjs";
import {
  clearInboundMedia,
  dropCancelRestoredInboundFor,
  extractHookMedia,
  mediaScope,
  mediaSourceFrom,
  rememberInboundMediaFor,
} from "./src/inbound-media.mjs";
import { discardUnpreparedInbox, isSessionResetCommand } from "./src/inbox-lifecycle.mjs";
import { maskFileNames } from "./src/log-redact.mjs";
import { closeStateStore, createRedisStateStore } from "./src/redis-client.mjs";
import { createOAWorkflowToolFactory } from "./src/tool.mjs";

function adapterResolveUrl() {
  const explicit = process.env.WECOM_OA_IDENTITY_ADAPTER_PATH?.trim();
  if (explicit) {
    return pathToFileURL(path.join(path.resolve(explicit), "src", "resolve.mjs")).href;
  }
  return new URL("../wecom-oa-identity-adapter/src/resolve.mjs", import.meta.url).href;
}

function resolveStateDir() {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) return path.dirname(path.resolve(configPath));
  return path.join(homedir(), ".openclaw-xa-it-service");
}

let stateStorePromise;
let activeStateStore;
let identityAdapterPromise;

function getStateStore(onError) {
  if (!stateStorePromise) {
    stateStorePromise = (async () => {
      try {
        const config = await loadBridgeConfig();
        const store = await createRedisStateStore(config.redis, { onError });
        activeStateStore = store;
        return store;
      } catch (error) {
        stateStorePromise = null;
        throw error;
      }
    })();
  }
  return stateStorePromise;
}

async function shutdownStore() {
  if (activeStateStore) {
    await closeStateStore(activeStateStore);
    activeStateStore = null;
  }
  stateStorePromise = null;
  identityAdapterPromise = null;
}

const plugin = {
  id: "oa-workflow-bridge-redis",
  name: "xA OA Workflow Bridge (Redis)",
  description: "Ecology OA submission bridge with Redis-backed pending and ledger for a single Gateway",
  configSchema: {
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    const stateDir = resolveStateDir();
    const onError = (error) => {
      api.logger.error(`[oa-workflow-bridge-redis] Redis error: ${error?.message || error}`);
    };
    const resolve = () => getStateStore(onError);
    void resolve().catch((error) => {
      api.logger.error(`[oa-workflow-bridge-redis] Redis init failed: ${error?.message || error}`);
    });
    api.registerTool(
      createOAWorkflowToolFactory({
        stateDir,
        resolveStateStore: resolve,
        logger: api.logger,
        dependencies: {
          resolveIdentityAdapter: async (store, config) => {
            if (config.identity?.adapter !== "on") return null;
            if (!identityAdapterPromise) {
              identityAdapterPromise = (async () => {
                try {
                  const { createIdentityResolverFromFiles } = await import(adapterResolveUrl());
                  return createIdentityResolverFromFiles({
                    redis: store.redis,
                    keyPrefix: store.keyPrefix,
                    oaConfig: config,
                  });
                } catch (error) {
                  identityAdapterPromise = null;
                  throw error;
                }
              })();
            }
            return identityAdapterPromise;
          },
        },
      }),
      { name: "oa_workflow" },
    );
    if (typeof api.on === "function") {
      const rememberFromHook = (label) => (event, ctx) => {
        const source = mediaSourceFrom(ctx, event);
        if (label === "message_received" && isSessionResetCommand(event, ctx)) {
          void resolve().then((store) => discardUnpreparedInbox({
            store,
            stateDir,
            source,
            logger: api.logger,
          })).catch((error) => {
            api.logger.warn?.(`[oa-workflow-bridge-redis] /new inbox wipe failed: ${error?.message || error}`);
          });
        }
        const sessionKey = mediaScope(source);
        const attachments = extractHookMedia(event, ctx, stateDir);
        if (!sessionKey) {
          api.logger.info(`[oa-workflow-bridge-redis] ${label}: no sessionKey extracted=${attachments.length}`);
          return;
        }
        if (label === "message_received") {
          const dropped = dropCancelRestoredInboundFor(source);
          if (dropped) {
            api.logger.info(`[oa-workflow-bridge-redis] dropped ${dropped} cancel-restored inbound attachment(s) on new message`);
          }
        }
        if (!attachments.length) {
          const mediaFacts = Array.isArray(event?.media) ? event.media.length : 0;
          const promptMedia = /\[media attached:/i.test(String(event?.prompt || ctx?.prompt || ""));
          api.logger.info(`[oa-workflow-bridge-redis] ${label}: no local media pending=${Boolean(event?.mediaStagingPending)} mediaFacts=${mediaFacts} promptMediaAttached=${promptMedia}`);
          return;
        }
        const count = rememberInboundMediaFor(source, attachments, {
          messageId: event?.messageId || ctx?.messageId,
        });
        api.logger.info(`[oa-workflow-bridge-redis] remembered ${count} inbound attachment(s) via ${label} (hook): ${maskFileNames(attachments)}`);
      };
      api.on("message_received", rememberFromHook("message_received"));
      api.on("agent_turn_prepare", rememberFromHook("agent_turn_prepare"));
      api.on("before_prompt_build", rememberFromHook("before_prompt_build"));
      api.on("session_end", (event, ctx) => {
        const source = mediaSourceFrom(ctx, event);
        void resolve().then((store) => discardUnpreparedInbox({
          store,
          stateDir,
          source,
          logger: api.logger,
        })).catch((error) => {
          api.logger.warn?.(`[oa-workflow-bridge-redis] session_end inbox wipe failed: ${error?.message || error}`);
        });
      });
      api.on("gateway_stop", async () => {
        clearInboundMedia();
        await shutdownStore();
      });
    }
    api.logger.info(`[oa-workflow-bridge-redis] loaded (Redis state) from ${fileURLToPath(import.meta.url)}`);
  },
  async shutdown() {
    clearInboundMedia();
    await shutdownStore();
  },
};

export default plugin;
