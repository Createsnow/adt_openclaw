import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "./src/config.mjs";
import { createMysqlDb, ensureSchema } from "./src/db.mjs";
import { createIdentityResolver } from "./src/identity/resolve.mjs";
import {
  clearInboundMedia,
  dropCancelRestoredInboundFor,
  extractHookMedia,
  isSessionResetCommand,
  mediaScope,
  mediaSourceFrom,
  rememberInboundMediaFor,
} from "./src/inbound-media.mjs";
import { maskFileNames } from "./src/log-redact.mjs";
import { cleanupExpired, createStore, discardUnpreparedInbox } from "./src/store.mjs";
import { createOAWorkflowToolFactory } from "./src/tool.mjs";

const LOG = "[oa-workflow-bridge]";
/** 定时回收：到期待确认单（24 小时）、过期 inbox / 身份缓存、孤儿 staging 目录。不依赖有人在用。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function resolveStateDir() {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) return path.dirname(path.resolve(configPath));
  return path.join(homedir(), ".openclaw-xa-it-service");
}

let storePromise;
let activeDb;
let sweepTimer;
let identityResolver;

function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const config = await loadBridgeConfig();
      const db = await createMysqlDb(config.mysql);
      try {
        await ensureSchema(db);
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
      activeDb = db;
      return createStore(db);
    })().catch((error) => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

async function shutdown() {
  clearInboundMedia();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  const db = activeDb;
  activeDb = null;
  storePromise = null;
  identityResolver = null;
  if (db) await db.close().catch(() => {});
}

const plugin = {
  id: "oa-workflow-bridge",
  name: "xA OA Workflow Bridge",
  description: "Ecology OA submission bridge with MySQL-backed tickets, inbox and identity cache for a single Gateway",
  configSchema: {
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    const stateDir = resolveStateDir();
    const warn = (label) => (error) => api.logger.warn?.(`${LOG} ${label}: ${error?.message || error}`);

    void getStore().catch((error) => api.logger.error(`${LOG} MySQL init failed: ${error?.message || error}`));
    sweepTimer = setInterval(() => {
      void getStore().then((store) => cleanupExpired(store, stateDir)).catch(warn("sweep failed"));
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();

    api.registerTool(
      createOAWorkflowToolFactory({
        stateDir,
        resolveStateStore: getStore,
        logger: api.logger,
        dependencies: {
          identityAdapter: async (store, config) => {
            identityResolver ||= createIdentityResolver({ store, oaBaseUrl: config.baseUrl });
            return identityResolver;
          },
        },
      }),
      { name: "oa_workflow" },
    );

    if (typeof api.on === "function") {
      const discardInbox = (source, label) => {
        void getStore()
          .then((store) => discardUnpreparedInbox({ store, stateDir, source, logger: api.logger }))
          .catch(warn(`${label} inbox wipe failed`));
      };
      const rememberFromHook = (label) => (event, ctx) => {
        const source = mediaSourceFrom(ctx, event);
        if (label === "message_received" && isSessionResetCommand(event, ctx)) discardInbox(source, "/new");
        const attachments = extractHookMedia(event, ctx, stateDir);
        if (!mediaScope(source)) {
          api.logger.info(`${LOG} ${label}: no sessionKey extracted=${attachments.length}`);
          return;
        }
        if (label === "message_received") {
          const dropped = dropCancelRestoredInboundFor(source);
          if (dropped) api.logger.info(`${LOG} dropped ${dropped} cancel-restored inbound attachment(s) on new message`);
        }
        if (!attachments.length) {
          const mediaFacts = Array.isArray(event?.media) ? event.media.length : 0;
          const promptMedia = /\[media attached:/i.test(String(event?.prompt || ctx?.prompt || ""));
          api.logger.info(`${LOG} ${label}: no local media pending=${Boolean(event?.mediaStagingPending)} mediaFacts=${mediaFacts} promptMediaAttached=${promptMedia}`);
          return;
        }
        rememberInboundMediaFor(source, attachments, { messageId: event?.messageId || ctx?.messageId });
        api.logger.info(`${LOG} remembered inbound attachment(s) via ${label} (hook): ${maskFileNames(attachments)}`);
      };
      api.on("message_received", rememberFromHook("message_received"));
      api.on("agent_turn_prepare", rememberFromHook("agent_turn_prepare"));
      api.on("before_prompt_build", rememberFromHook("before_prompt_build"));
      api.on("session_end", (event, ctx) => discardInbox(mediaSourceFrom(ctx, event), "session_end"));
      api.on("gateway_stop", shutdown);
    }
    api.logger.info(`${LOG} loaded (MySQL state) from ${fileURLToPath(import.meta.url)}`);
  },
  shutdown,
};

export default plugin;
