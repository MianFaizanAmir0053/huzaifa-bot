import { describe, expect, it } from "vitest";
import type { InboundMessage, OutboundAction } from "@huzaifa/contracts";
import type { MessageClassifier } from "./classifier";
import type { BrainRepository, IngestResult } from "@/catalog/repository";
import type { CatalogProduct } from "@/catalog/types";
import { processInboundMessage } from "./orchestrator";

const product: CatalogProduct = {
  id: "8c5d535e-5054-4ff9-b8db-2af7caf10df2",
  sku: "KRT-001",
  name: "Emerald Lawn Kurta",
  description: "Printed lawn kurta",
  category: "kurta",
  color: "green",
  material: "lawn",
  pricePkr: 4500,
  similarityScore: 0.9,
  variants: [
    { size: "S", normalizedSize: "s", stockQty: 2 },
    { size: "M", normalizedSize: "m", stockQty: 0 },
  ],
};

class TestRepository implements BrainRepository {
  actions: OutboundAction[] = [];
  handoffStarted = false;
  constructor(private readonly products: CatalogProduct[] = [product], private readonly paused = false) {}

  async ingestInbound(): Promise<IngestResult> {
    return {
      duplicate: false,
      conversation: {
        id: "conversation-1",
        state: this.paused ? "human_active" : "bot_active",
        activeProductId: null,
      },
    };
  }

  async searchCatalog(_query: string, _limit?: number): Promise<CatalogProduct[]> {
    void _query;
    void _limit;
    return this.products;
  }

  async saveActions(_conversationId: string, actions: OutboundAction[]): Promise<void> {
    this.actions = actions;
  }

  async beginHandoff(): Promise<void> {
    this.handoffStarted = true;
  }
}

const message = (text: string): InboundMessage => ({
  eventId: "evt-1",
  messageId: "msg-1",
  chatId: "923001234567@c.us",
  occurredAt: "2026-09-28T12:00:00.000Z",
  type: "text",
  text,
});

describe("processInboundMessage", () => {
  it("renders live size stock without exposing quantities", async () => {
    const response = await processInboundMessage(message("Is medium available?"), {
      repository: new TestRepository(),
      supportChatId: "support@c.us",
    });

    expect(response.actions[0]).toMatchObject({ type: "text" });
    const reply = response.actions[0].type === "text" ? response.actions[0].text : "";
    expect(reply).toContain("not in stock");
    expect(reply).not.toMatch(/stock(?:Qty)?:\s*0/i);
  });

  it("pauses automation during human takeover", async () => {
    const response = await processInboundMessage(message("show green kurtas"), {
      repository: new TestRepository([product], true),
      supportChatId: "support@c.us",
    });
    expect(response.actions).toEqual([]);
  });

  it("creates customer and support actions for handoff", async () => {
    const repository = new TestRepository();
    const response = await processInboundMessage(message("I want a human"), {
      repository,
      supportChatId: "support@c.us",
    });
    expect(repository.handoffStarted).toBe(true);
    expect(response.actions).toHaveLength(2);
    expect(response.actions[1].recipientChatId).toBe("support@c.us");
  });

  it("searches by what the AI saw in a photo sent without a caption", async () => {
    const repository = new TestRepository();
    let searchedFor = "";
    repository.searchCatalog = async (query: string) => {
      searchedFor = query;
      return [product];
    };
    const classifier: MessageClassifier = {
      classify: async () => ({
        language: "en",
        intent: "product_search",
        attributes: { query: "green printed kurta" },
        suppliedLead: {},
        handoffRequested: false,
        confidence: 0.8,
      }),
    };
    const photo: InboundMessage = {
      ...message("x"),
      type: "image",
      text: undefined,
      media: { objectPath: "messages/aaa/bbb.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
    };

    const response = await processInboundMessage(photo, { repository, classifier, supportChatId: "support@c.us" });
    expect(searchedFor).toBe("green printed kurta");
    expect(response.actions[0].type === "text" ? response.actions[0].text : "").toContain("Emerald Lawn Kurta");
  });

  it("uses validated AI attributes for multilingual search", async () => {
    const repository = new TestRepository();
    let searchedFor = "";
    repository.searchCatalog = async (query: string) => {
      searchedFor = query;
      return [product];
    };
    const classifier: MessageClassifier = {
      classify: async () => ({
        language: "roman_ur",
        intent: "product_search",
        attributes: { query: "green lawn kurta", requestedSize: "m" },
        suppliedLead: {},
        handoffRequested: false,
        confidence: 0.94,
      }),
    };

    const response = await processInboundMessage(message("mujhe hara lawn wala medium mein chahiye"), {
      repository,
      classifier,
      supportChatId: "support@c.us",
    });

    expect(searchedFor).toBe("green lawn kurta");
    expect(response.actions[0].type === "text" ? response.actions[0].text : "").toContain("available nahi hai");
  });
});