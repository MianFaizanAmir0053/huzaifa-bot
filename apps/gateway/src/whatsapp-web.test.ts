import type { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "whatsapp-web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportOwnerMessage } from "./transport.js";
import { WhatsAppWebTransport } from "./whatsapp-web.js";

const { MessageMedia } = pkg;
const customer = "923001234567@c.us";
const lid = "98100000000068@lid";
const photo = "https://project.supabase.co/storage/v1/object/public/product-images/kurta-green.jpg";
const silent = { info() {}, warn() {}, error() {} };

// The browser is never started: the tests drive the transport through its WhatsApp client's events and methods.
function linkedTransport() {
  const transport = new WhatsAppWebTransport(join(tmpdir(), "huzaifa-gateway-test-auth"), silent);
  const client = (transport as unknown as { client: EventEmitter & Record<string, unknown> }).client;
  client.emit("ready");
  client.getContactLidAndPhone = vi.fn(async () => [{ lid, pn: customer }]);
  const ownerMessages: TransportOwnerMessage[] = [];
  transport.onOwnerMessage(async (message) => {
    ownerMessages.push(message);
  });
  return { transport, client, ownerMessages };
}

// What "message_create" delivers for a message this account sent.
function sentByAccount(overrides: Record<string, unknown> = {}) {
  return { fromMe: true, to: customer, type: "chat", body: "", timestamp: 1_790_000_000, id: { fromMe: true, remote: customer, id: "OWNER1" }, ...overrides };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("owner messages", () => {
  it("reports what the owner types, with the customer's other id", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ body: "Main dekhti hoon" }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(1));
    expect(ownerMessages[0]).toEqual({
      id: `true_${customer}_OWNER1`,
      chatId: customer,
      alternateChatIds: [lid],
      occurredAt: new Date(1_790_000_000_000).toISOString(),
      type: "text",
      text: "Main dekhti hoon",
    });
  });

  it("does not mistake the gateway's own sends for the owner", async () => {
    const { transport, client, ownerMessages } = linkedTransport();
    let echoTo = customer;
    let sends = 0;
    client.sendMessage = vi.fn(async (_chatId: string, content: string) => {
      const id = { fromMe: true, remote: echoTo, id: `BOT${(sends += 1)}` };
      // WhatsApp can echo a send well before sendMessage returns its id, and can file it under the contact's other id.
      client.emit("message_create", sentByAccount({ to: echoTo, id, body: content }));
      await settle();
      return { id };
    });
    await transport.sendText(customer, "Here you go");
    echoTo = lid;
    await transport.sendText(customer, "Anything else?");
    await settle();
    expect(ownerMessages).toEqual([]);

    // The owner later typing the same words is still the owner.
    client.emit("message_create", sentByAccount({ body: "Here you go" }));
    await vi.waitFor(() => expect(ownerMessages.map((message) => message.text)).toEqual(["Here you go"]));
  });

  it("reports voice notes and other media the owner sends as a placeholder", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ type: "ptt", body: "", id: { fromMe: true, remote: customer, id: "VOICE1" } }));
    client.emit("message_create", sentByAccount({ type: "document", body: "invoice.pdf", id: { fromMe: true, remote: customer, id: "DOC1" } }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(2));
    // A document's body is its file name, not something the owner typed.
    expect(ownerMessages.map((message) => [message.type, message.text])).toEqual([
      ["text", "[voice note]"],
      ["text", "[document]"],
    ]);
  });

  it("ignores incoming messages, groups, status updates and unsupported types", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ fromMe: false, body: "hi" }));
    client.emit("message_create", sentByAccount({ to: "120363000000000000@g.us", body: "group" }));
    client.emit("message_create", sentByAccount({ to: "status@broadcast", body: "status" }));
    client.emit("message_create", sentByAccount({ type: "e2e_notification" }));
    await settle();
    expect(ownerMessages).toEqual([]);
  });
});

// What the "message" event delivers for a customer's message.
function received(overrides: Record<string, unknown> = {}) {
  return {
    fromMe: false,
    from: customer,
    type: "chat",
    body: "",
    hasMedia: false,
    timestamp: 1_790_000_000,
    id: { fromMe: false, remote: customer, id: "IN1" },
    getContact: async () => ({ pushname: "Ayesha" }),
    ...overrides,
  };
}

describe("incoming messages", () => {
  it("hands each chat's messages over in arrival order, even when a photo is slow to download", async () => {
    const { transport, client } = linkedTransport();
    const seen: string[] = [];
    transport.onMessage(async (message) => {
      seen.push(message.text ?? "");
    });
    let finishDownload = () => {};
    const downloadMedia = () =>
      new Promise((resolve) => {
        finishDownload = () => resolve({ mimetype: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
      });
    client.emit("message", received({ type: "image", hasMedia: true, body: "this one", downloadMedia, id: { fromMe: false, remote: customer, id: "IN1" } }));
    client.emit("message", received({ body: "in red?", id: { fromMe: false, remote: customer, id: "IN2" } }));
    await settle();
    expect(seen).toEqual([]);
    finishDownload();
    await vi.waitFor(() => expect(seen).toEqual(["this one", "in red?"]));
  });

  it("doesn't let a hung contact lookup hold the chat back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { transport, client } = linkedTransport();
      const seen: string[] = [];
      transport.onMessage(async (message) => {
        seen.push(message.text ?? "");
      });
      client.emit("message", received({ body: "salam", getContact: () => new Promise(() => {}) }));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(seen).toEqual(["salam"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for the answer before handing over the next message", async () => {
    const { transport, client } = linkedTransport();
    const seen: string[] = [];
    // A handler that answers slowly (the whole brain turn) must not hold back the customer's next message.
    transport.onMessage((message) => {
      seen.push(message.text ?? "");
      return new Promise(() => {});
    });
    client.emit("message", received({ body: "salam", id: { fromMe: false, remote: customer, id: "IN1" } }));
    client.emit("message", received({ body: "green kurta", id: { fromMe: false, remote: customer, id: "IN2" } }));
    await vi.waitFor(() => expect(seen).toEqual(["salam", "green kurta"]));
  });
});

describe("sending", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads a catalog photo and sends it with its caption", async () => {
    const { transport, client, ownerMessages } = linkedTransport();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const sendMessage = vi.fn(async (chatId: string, _media: unknown, _options?: unknown) => ({ id: { fromMe: true, remote: chatId, id: "IMG1" } }));
    client.sendMessage = sendMessage;

    await expect(transport.sendImage(customer, photo, "Green kurta")).resolves.toBe(`true_${customer}_IMG1`);
    const [chatId, media, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(customer);
    expect(media).toBeInstanceOf(MessageMedia);
    expect(media).toMatchObject({ mimetype: "image/png", data: Buffer.from([1, 2, 3]).toString("base64"), filename: "kurta-green.jpg" });
    expect(options).toEqual({ caption: "Green kurta" });

    client.emit("message_create", sentByAccount({ type: "image", body: "Green kurta", id: { fromMe: true, remote: customer, id: "IMG1" } }));
    await settle();
    expect(ownerMessages).toEqual([]);
  });

  it("marks sends that never reached WhatsApp as safe to retry", async () => {
    const { transport, client } = linkedTransport();
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    client.sendMessage = vi.fn(async () => ({ id: { fromMe: true, remote: customer, id: "X" } }));
    await expect(transport.sendImage(customer, photo, "Green kurta")).rejects.toMatchObject({ name: "NotSentError" });
    expect(client.sendMessage).not.toHaveBeenCalled();

    // (Not "disconnected": that schedules a reconnect, which would start a real browser.)
    client.emit("auth_failure", "session revoked");
    await expect(transport.sendText(customer, "hi")).rejects.toMatchObject({ name: "NotSentError" });
  });

  it("shows and clears typing, and never throws for it", async () => {
    const { transport, client } = linkedTransport();
    const chat = { sendStateTyping: vi.fn(async () => {}), clearState: vi.fn(async () => true) };
    client.getChatById = vi.fn(async () => chat);
    await transport.setTyping(customer, true);
    await transport.setTyping(customer, false);
    expect(chat.sendStateTyping).toHaveBeenCalledOnce();
    expect(chat.clearState).toHaveBeenCalledOnce();

    client.getChatById = vi.fn(async () => {
      throw new Error("Target closed");
    });
    await expect(transport.setTyping(customer, true)).resolves.toBeUndefined();
    client.getChatById = vi.fn(async () => undefined);
    await expect(transport.setTyping(customer, true)).resolves.toBeUndefined();
  });
});
