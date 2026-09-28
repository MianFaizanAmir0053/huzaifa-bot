import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InboundMessage, OutboundAction } from "@huzaifa/contracts";
import type { CatalogProduct, ProductVariant } from "./types";

export type ConversationContext = {
  id: string;
  state: "bot_active" | "handoff_requested" | "human_active";
  activeProductId: string | null;
};

export type IngestResult = {
  duplicate: boolean;
  conversation: ConversationContext;
};

export interface BrainRepository {
  ingestInbound(message: InboundMessage): Promise<IngestResult>;
  searchCatalog(query: string, limit?: number): Promise<CatalogProduct[]>;
  saveActions(conversationId: string, actions: OutboundAction[]): Promise<void>;
  beginHandoff(conversationId: string, reason: string, notificationActionId: string): Promise<void>;
}

type SearchCatalogRow = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  price_pkr: number;
  similarity_score: number;
  variants: ProductVariant[];
};

export class SupabaseBrainRepository implements BrainRepository {
  constructor(private readonly client: SupabaseClient) {}

  async ingestInbound(message: InboundMessage): Promise<IngestResult> {
    const { data: contact, error: contactError } = await this.client
      .from("contacts")
      .upsert(
        { whatsapp_chat_id: message.chatId, display_name: message.displayName ?? null },
        { onConflict: "whatsapp_chat_id" },
      )
      .select("id")
      .single();
    if (contactError) throw contactError;

    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .upsert({ contact_id: contact.id, last_message_at: message.occurredAt }, { onConflict: "contact_id" })
      .select("id,state,active_product_id")
      .single();
    if (conversationError) throw conversationError;

    const { error: messageError } = await this.client.from("messages").insert({
      conversation_id: conversation.id,
      provider_message_id: message.messageId,
      event_id: message.eventId,
      direction: "inbound",
      source: "customer",
      content_type: message.type,
      text_content: message.text ?? null,
      media_path: message.media?.objectPath ?? null,
      occurred_at: message.occurredAt,
    });

    if (messageError?.code === "23505") {
      return { duplicate: true, conversation: mapConversation(conversation) };
    }
    if (messageError) throw messageError;
    return { duplicate: false, conversation: mapConversation(conversation) };
  }

  async searchCatalog(query: string, limit = 3): Promise<CatalogProduct[]> {
    const { data, error } = await this.client.rpc("search_catalog", {
      search_query: query,
      result_limit: limit,
    });
    if (error) throw error;

    return ((data ?? []) as SearchCatalogRow[]).map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      category: product.category,
      color: product.color,
      material: product.material,
      pricePkr: product.price_pkr,
      similarityScore: product.similarity_score,
      variants: product.variants,
    }));
  }

  async saveActions(conversationId: string, actions: OutboundAction[]): Promise<void> {
    if (actions.length === 0) return;
    const now = new Date().toISOString();
    const rows = actions.map((action) => ({
      conversation_id: conversationId,
      direction: "outbound",
      source: "agent",
      content_type: action.type,
      text_content: action.type === "text" ? action.text : action.caption ?? null,
      media_path: action.type === "image" ? action.objectPath : null,
      reply_action_id: action.actionId,
      delivery_state: "pending",
      occurred_at: now,
    }));
    const { error } = await this.client.from("messages").insert(rows);
    if (error) throw error;
  }

  async beginHandoff(conversationId: string, reason: string, notificationActionId: string): Promise<void> {
    const { error: conversationError } = await this.client
      .from("conversations")
      .update({ state: "human_active" })
      .eq("id", conversationId);
    if (conversationError) throw conversationError;

    const { error: handoffError } = await this.client.from("handoffs").insert({
      conversation_id: conversationId,
      reason,
      notification_action_id: notificationActionId,
    });
    if (handoffError) throw handoffError;
  }
}

export function createSupabaseBrainRepository(url: string, serviceRoleKey: string): BrainRepository {
  return new SupabaseBrainRepository(
    createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } }),
  );
}

function mapConversation(row: { id: string; state: string; active_product_id: string | null }): ConversationContext {
  return {
    id: row.id,
    state: row.state as ConversationContext["state"],
    activeProductId: row.active_product_id,
  };
}