import { config as loadEnvironment } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { OpenAiInvestigator } from "./openai.js";
import { SqliteOrderRepository } from "./order-store.js";
import { PayPalClient } from "./paypal.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(projectRoot, ".env") });
const config = readConfig();
const paypal = new PayPalClient({
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
  baseUrl: config.PAYPAL_API_BASE_URL
});
const orders = new SqliteOrderRepository(resolve(projectRoot, config.DATABASE_PATH));
const investigator = config.OPENAI_API_KEY
  ? new OpenAiInvestigator(
    config.OPENAI_API_KEY,
    config.OPENAI_MODEL,
    config.OPENAI_API_BASE_URL,
    config.OPENAI_TIMEOUT_MS
  )
  : undefined;
const importedOrders = await orders.importLegacyJson(resolve(projectRoot, config.ORDER_STORE_PATH));
if (importedOrders > 0) {
  console.log(`Imported ${importedOrders} legacy order record(s) into SQLite`);
}
const app = createApp({
  paypal,
  orders,
  paypalClientId: config.PAYPAL_CLIENT_ID,
  paypalWebhookId: config.PAYPAL_WEBHOOK_ID,
  webOrigin: config.WEB_ORIGIN,
  demoMode: config.DEMO_MODE,
  reconciliationGraceMs: config.RECONCILIATION_GRACE_MS,
  ...(investigator ? { investigator } : {})
});

app.listen(config.PORT, () => {
  console.log(`PayTrace API listening on http://localhost:${config.PORT}`);
});

