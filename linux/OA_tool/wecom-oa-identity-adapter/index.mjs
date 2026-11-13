import { fileURLToPath } from "node:url";

const plugin = {
  id: "wecom-oa-identity-adapter",
  name: "WeCom OA Identity Adapter",
  description: "Resolves WeCom sender ids to OA person ids. Does not register model tools.",
  configSchema: {
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    api.logger.info(`[wecom-oa-identity-adapter] loaded from ${fileURLToPath(import.meta.url)} (no tools)`);
  },
};

export default plugin;
