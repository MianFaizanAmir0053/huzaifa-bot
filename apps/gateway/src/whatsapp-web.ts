import QRCode from "qrcode";
import pkg from "whatsapp-web.js";
import type { MessageHandler, SessionSnapshot, WhatsAppTransport } from "./transport.js";

const { Client, LocalAuth } = pkg;

export class WhatsAppWebTransport implements WhatsAppTransport {
  private readonly handlers = new Set<MessageHandler>();
  private snapshot: SessionSnapshot = { state: "starting" };
  private readonly client;

  constructor(authPath: string) {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      },
    });

    this.client.on("qr", async (qr) => {
      this.snapshot = { state: "qr_pending", qrDataUrl: await QRCode.toDataURL(qr) };
    });
    this.client.on("ready", () => {
      this.snapshot = { state: "ready" };
    });
    this.client.on("disconnected", (reason) => {
      this.snapshot = { state: "disconnected", detail: String(reason) };
    });
    this.client.on("auth_failure", (detail) => {
      this.snapshot = { state: "error", detail };
    });
    this.client.on("message", async (message) => {
      const chat = await message.getChat();
      const contact = await message.getContact();
      const media = message.hasMedia ? await message.downloadMedia() : undefined;
      const transportMessage = {
        id: message.id._serialized,
        chatId: message.from,
        displayName: contact.pushname || contact.name || undefined,
        occurredAt: new Date(message.timestamp * 1_000).toISOString(),
        fromMe: message.fromMe,
        isGroup: chat.isGroup,
        text: message.body || undefined,
        media: media
          ? { mimeType: media.mimetype, dataBase64: media.data, fileName: media.filename ?? undefined }
          : undefined,
      };
      await Promise.allSettled([...this.handlers].map((handler) => handler(transportMessage)));
    });
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  async logout(): Promise<void> {
    await this.client.logout();
    this.snapshot = { state: "disconnected", detail: "Logged out" };
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const sent = await this.client.sendMessage(chatId, text);
    return sent.id._serialized;
  }

  getSessionSnapshot(): SessionSnapshot {
    return this.snapshot;
  }
}