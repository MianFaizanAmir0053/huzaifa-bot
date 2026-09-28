import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { WhatsAppTransport } from "./transport.js";

export function buildServer(transport: WhatsAppTransport, adminToken: string) {
  const server = Fastify({ logger: true });

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async (_request, reply) => {
    const session = transport.getSessionSnapshot();
    return reply.code(session.state === "ready" ? 200 : 503).send({ status: session.state });
  });
  server.get("/session", { preHandler: authenticate }, async () => transport.getSessionSnapshot());
  server.post("/session/logout", { preHandler: authenticate }, async () => {
    await transport.logout();
    return { status: "logged_out" };
  });

  function authenticate(request: FastifyRequest, reply: FastifyReply): void {
    if (request.headers.authorization !== `Bearer ${adminToken}`) {
      void reply.code(401).send({ error: "Unauthorized" });
    }
  }

  return server;
}