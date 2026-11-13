import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "./src/config.mjs";
import { createMysqlDb, ensureSchema } from "./src/db.mjs";
import { createIdentityResolver } from "./src/identity/resolve.mjs";
import { captureInbound } from "./src/inbox.mjs";
import { extractHookMedia, isSessionResetCommand, mediaSourceFrom, senderIdOf } from "./src/inbound-media.mjs";
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
      // 附件一出现就落进库里的 inbox（拷进本机 staging），不在进程内缓冲。
      const captureFromHook = (label) => (event, ctx) => {
        const source = mediaSourceFrom(ctx, event);
        if (label === "message_received" && isSessionResetCommand(event, ctx)) {
          discardInbox(source, "/new");
          return;
        }
        const attachments = extractHookMedia(event, ctx, stateDir);
        if (!attachments.length) return;
        if (!senderIdOf(source)) {
          api.logger.info(`${LOG} ${label}: media without sender, left to tool ctx (${attachments.length})`);
          return;
        }
        void Promise.all([getStore(), loadBridgeConfig()])
          .then(([store, config]) => captureInbound({ store, stateDir, config, source, attachments }))
          .then(() => api.logger.info(`${LOG} captured inbound via ${label}: ${maskFileNames(attachments)}`))
          .catch(warn(`${label} capture failed`));
      };
      api.on("message_received", captureFromHook("message_received"));
      api.on("agent_turn_prepare", captureFromHook("agent_turn_prepare"));
      api.on("before_prompt_build", captureFromHook("before_prompt_build"));
      api.on("session_end", (event, ctx) => discardInbox(mediaSourceFrom(ctx, event), "session_end"));
      api.on("gateway_stop", shutdown);
    }
    api.logger.info(`${LOG} loaded (MySQL state) from ${fileURLToPath(import.meta.url)}`);
  },
  shutdown,
};

export default plugin;
