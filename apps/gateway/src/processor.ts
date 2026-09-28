import { InboundMessageSchema, MediaUploadRequestSchema } from "@huzaifa/contracts";
import type { BrainClient } from "./brain-client.js";
import type { TransportMessage, WhatsAppTransport } from "./transport.js";

export class MessageProcessor {
  private readonly chatQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly transport: WhatsAppTransport,
    private readonly brainClient: BrainClient,
  ) {}

  enqueue(message: TransportMessage): Promise<void> {
    if (message.fromMe || message.isGroup || (!message.text && !message.media)) return Promise.resolve();

    const previous = this.chatQueues.get(message.chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.process(message))
      .finally(() => {
        if (this.chatQueues.get(message.chatId) === current) this.chatQueues.delete(message.chatId);
      });
    this.chatQueues.set(message.chatId, current);
    return current;
  }

  private async process(message: TransportMessage): Promise<void> {
    let media;
    if (message.media) {
      const bytes = Buffer.from(message.media.dataBase64, "base64");
      const uploadRequest = MediaUploadRequestSchema.parse({
        messageId: message.id,
        chatId: message.chatId,
        mimeType: message.media.mimeType,
        sizeBytes: bytes.byteLength,
        fileName: message.media.fileName,
      });
      const grant = await this.brainClient.createMediaUpload(uploadRequest);
      await this.brainClient.uploadMedia(grant, bytes, uploadRequest.mimeType);
      media = {
        objectPath: grant.objectPath,
        mimeType: uploadRequest.mimeType,
        sizeBytes: uploadRequest.sizeBytes,
        fileName: uploadRequest.fileName,
      };
    }

    const inbound = InboundMessageSchema.parse({
      eventId: message.id,
      messageId: message.id,
      chatId: message.chatId,
      displayName: message.displayName,
      occurredAt: message.occurredAt,
      type: media ? "image" : "text",
      text: message.text,
      media,
    });
    const result = await this.brainClient.processMessage(inbound);

    for (const action of result.actions) {
      if (action.type === "text") {
        await this.transport.sendText(action.recipientChatId, action.text);
      }
    }
  }
}