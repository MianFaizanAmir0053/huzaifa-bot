import { describe, expect, it } from "vitest";
import {
  BrainResponseSchema,
  InboundMessageSchema,
  MediaUploadGrantSchema,
  MediaUploadRequestSchema,
} from "./index.js";

describe("InboundMessageSchema", () => {
  it("accepts a valid text message", () => {
    const result = InboundMessageSchema.safeParse({
      eventId: "evt-1",
      messageId: "wamid-1",
      chatId: "923001234567@c.us",
      occurredAt: "2026-09-28T00:00:00.000Z",
      type: "text",
      text: "Do you have this in medium?",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an image event without uploaded media", () => {
    const result = InboundMessageSchema.safeParse({
      eventId: "evt-2",
      messageId: "wamid-2",
      chatId: "923001234567@c.us",
      occurredAt: "2026-09-28T00:00:00.000Z",
      type: "image",
    });

    expect(result.success).toBe(false);
  });
});

describe("BrainResponseSchema", () => {
  it("limits outbound actions to protect the gateway", () => {
    const actions = Array.from({ length: 5 }, (_, index) => ({
      actionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      recipientChatId: "923001234567@c.us",
      type: "text",
      text: "Hello",
    }));

    expect(BrainResponseSchema.safeParse({ eventId: "evt-1", actions }).success).toBe(false);
  });
});

describe("media upload contracts", () => {
  it("accepts supported image metadata", () => {
    expect(
      MediaUploadRequestSchema.safeParse({
        messageId: "wamid-image-1",
        chatId: "923001234567@c.us",
        mimeType: "image/webp",
        sizeBytes: 4_096,
        fileName: "product.webp",
      }).success,
    ).toBe(true);
  });

  it("rejects oversized media and insecure grants", () => {
    expect(
      MediaUploadRequestSchema.safeParse({
        messageId: "wamid-image-2",
        chatId: "923001234567@c.us",
        mimeType: "image/jpeg",
        sizeBytes: 10 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      MediaUploadGrantSchema.safeParse({
        bucket: "inbound-media",
        objectPath: "2026-09-28/image.jpg",
        signedUrl: "http://example.com/upload",
        expiresAt: "2026-09-28T14:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
describe("DeliveryReportSchema", () => {
  it("accepts sent and failed acknowledgements and rejects empty reports", async () => {
    const { DeliveryReportSchema } = await import("./index");
    expect(
      DeliveryReportSchema.parse({
        acknowledgements: [
          { actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a111", status: "sent", providerMessageId: "true_923@c.us_ABC" },
          { actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a112", status: "failed", errorCode: "send_failed" },
        ],
      }).acknowledgements,
    ).toHaveLength(2);
    expect(DeliveryReportSchema.safeParse({ acknowledgements: [] }).success).toBe(false);
  });
});
