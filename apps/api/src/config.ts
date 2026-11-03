import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_API_BASE_URL: z.string().url().default("https://api-m.sandbox.paypal.com"),
  DATABASE_PATH: z.string().default("./data/paytrace.sqlite"),
  ORDER_STORE_PATH: z.string().default("./data/orders.json")
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment configuration: ${fields}`);
  }
  return result.data;
}

