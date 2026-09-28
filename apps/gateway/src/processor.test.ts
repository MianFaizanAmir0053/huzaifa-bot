import { describe, expect, it } from "vitest";
import { BrainClient } from "./brain-client.js";
import { MessageProcessor } from "./processor.js";
import type { MessageHandler, SessionSnapshot, WhatsAppTransport } from "./transport.js";

class TestTransport implements WhatsAppTransport {
  sent: Array<{ chatId: string; text: string }> = [];
  async initialize() {}
  async destroy() {}
  async logout() {}
  onMessage(_handler: MessageHandler) {}
  getSessionSnapshot(): SessionSnapshot { return { state: "ready" }; }
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return `sent-${this.sent.length}`;
  }
}

describe("MessageProcessor", () => {
  it("signs a text event and sends validated actions", async () => {
    let signature = "";
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async (_input, init) => {
        signature = new Headers(init?.headers).get("x-huzaifa-signature") ?? "";
        return Response.json({
          eventId: "message-1",
          duplicate: false,
          actions: [
            {
              actionId: "6f548628-7b8a-4e29-92fc-b19829adccf6",
              recipientChatId: "customer@c.us",
              type: "text",
              text: "Grounded reply",
            },
          ],
        });
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain);

    await processor.enqueue({
      id: "message-1",
      chatId: "customer@c.us",
      occurredAt: "2026-09-28T12:00:00.000Z",
      fromMe: false,
      isGroup: false,
      text: "green kurta",
    });

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(transport.sent).toEqual([{ chatId: "customer@c.us", text: "Grounded reply" }]);
  });

  it("ignores owner and group messages", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async () => { throw new Error("should not call brain"); },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain);
    await processor.enqueue({ id: "1", chatId: "one", occurredAt: new Date().toISOString(), fromMe: true, isGroup: false, text: "hi" });
    await processor.enqueue({ id: "2", chatId: "group", occurredAt: new Date().toISOString(), fromMe: false, isGroup: true, text: "hi" });
    expect(transport.sent).toEqual([]);
  });

  it("uploads image bytes before forwarding image metadata", async () => {
    const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        const url = input.toString();
        calls.push({ url, method: init?.method, body: init?.body });
        if (url.endsWith("/api/gateway/media-upload")) {
          return Response.json({
            bucket: "inbound-media",
            objectPath: "messages/chat-hash/message-hash.png",
            signedUrl:
              "https://project.supabase.co/storage/v1/object/upload/sign/inbound-media/messages/chat-hash/message-hash.png?token=signed-token",
            expiresAt: "2026-09-28T14:00:00.000Z",
          });
        }
        if (url.startsWith("https://project.supabase.co/storage/")) {
          return Response.json({ Key: "inbound-media/messages/chat-hash/message-hash.png" });
        }
        return Response.json({ eventId: "image-1", duplicate: false, actions: [] });
      },
    });
    const processor = new MessageProcessor(new TestTransport(), brain);

    await processor.enqueue({
      id: "image-1",
      chatId: "customer@c.us",
      occurredAt: "2026-09-28T12:00:00.000Z",
      fromMe: false,
      isGroup: false,
      text: "green lawn kurta",
      media: {
        mimeType: "image/png",
        dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        fileName: "customer.png",
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
    expect(calls[1].body).toBeInstanceOf(ArrayBuffer);
    const forwarded = JSON.parse(String(calls[2].body));
    expect(forwarded).toMatchObject({
      type: "image",
      text: "green lawn kurta",
      media: {
        objectPath: "messages/chat-hash/message-hash.png",
        mimeType: "image/png",
        sizeBytes: 4,
      },
    });
    expect(forwarded.media).not.toHaveProperty("dataBase64");
  });
});