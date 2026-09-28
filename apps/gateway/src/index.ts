import { BrainClient } from "./brain-client.js";
import { getGatewayEnvironment } from "./config.js";
import { MessageProcessor } from "./processor.js";
import { buildServer } from "./server.js";
import { WhatsAppWebTransport } from "./whatsapp-web.js";

const environment = getGatewayEnvironment();
const transport = new WhatsAppWebTransport(environment.WHATSAPP_AUTH_PATH);
const brainClient = new BrainClient({
  baseUrl: environment.BRAIN_BASE_URL,
  hmacSecret: environment.GATEWAY_HMAC_SECRET,
  timeoutMs: environment.WEBHOOK_TIMEOUT_MS,
});
const processor = new MessageProcessor(transport, brainClient);
const server = buildServer(transport, environment.GATEWAY_ADMIN_TOKEN);

transport.onMessage((message) => processor.enqueue(message));

const shutdown = async () => {
  await server.close();
  await transport.destroy();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await server.listen({ port: environment.PORT, host: environment.HOST });
void transport.initialize().catch((error) => server.log.error(error, "WhatsApp initialization failed"));