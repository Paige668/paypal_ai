import { config as loadEnvironment } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { JsonOrderRepository } from "./order-store.js";
import { PayPalClient } from "./paypal.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(projectRoot, ".env") });
const config = readConfig();
const paypal = new PayPalClient({
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
  baseUrl: config.PAYPAL_API_BASE_URL
});
const orders = new JsonOrderRepository(resolve(projectRoot, config.ORDER_STORE_PATH));
const app = createApp({
  paypal,
  orders,
  paypalClientId: config.PAYPAL_CLIENT_ID,
  webOrigin: config.WEB_ORIGIN
});

app.listen(config.PORT, () => {
  console.log(`PayTrace API listening on http://localhost:${config.PORT}`);
});

