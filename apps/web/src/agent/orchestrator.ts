import { randomUUID } from "node:crypto";
import type { BrainResponse, InboundMessage, Language, OutboundAction } from "@huzaifa/contracts";
import type { BrainRepository } from "@/catalog/repository";
import type { MessageClassifier } from "./classifier";
import { renderGreeting, renderHandoff, renderNoMatch, renderProduct } from "./renderer";

const HANDOFF_PATTERN = /\b(human|person|agent|representative|staff|owner|insaan|banda)\b|انسان|نمائندہ/i;
const GREETING_PATTERN = /^(hi|hello|hey|salam|assalam|السلام)[!. ]*$/i;
const SIZE_PATTERN = /\b(?:size\s*)?(xs|s|m|l|xl|xxl|small|medium|large)\b/i;

export type OrchestratorDependencies = {
  repository: BrainRepository;
  supportChatId: string;
  classifier?: MessageClassifier;
};

export async function processInboundMessage(
  message: InboundMessage,
  dependencies: OrchestratorDependencies,
): Promise<BrainResponse> {
  const ingested = await dependencies.repository.ingestInbound(message);
  if (ingested.duplicate || ingested.conversation.state === "human_active") {
    return { eventId: message.eventId, duplicate: ingested.duplicate, actions: [] };
  }

  const text = message.text?.trim() ?? "";
  const classification = dependencies.classifier
    ? await dependencies.classifier.classify(message).catch(() => undefined)
    : undefined;
  const language = classification?.language ?? detectLanguage(text);
  let actions: OutboundAction[];

  if (classification?.handoffRequested || classification?.intent === "human_handoff" || HANDOFF_PATTERN.test(text)) {
    const customerAction = textAction(message.chatId, renderHandoff(language));
    const supportAction = textAction(
      dependencies.supportChatId,
      `Handoff requested by ${message.displayName ?? message.chatId}. Chat: ${message.chatId}`,
    );
    await dependencies.repository.beginHandoff(
      ingested.conversation.id,
      "Customer requested a person",
      supportAction.actionId,
    );
    actions = [customerAction, supportAction];
  } else if (classification?.intent === "greeting" || GREETING_PATTERN.test(text)) {
    actions = [textAction(message.chatId, renderGreeting(language))];
  } else if (message.type === "image" && !text && !cleanOptional(classification?.attributes.query)) {
    actions = [textAction(message.chatId, renderNoMatch(language))];
  } else {
    const requestedSize = cleanOptional(classification?.attributes.requestedSize) ?? extractSize(text);
    const searchQuery = cleanOptional(classification?.attributes.query) ?? text;
    const products = await dependencies.repository.searchCatalog(searchQuery, 3);
    actions = products.length === 0
      ? [textAction(message.chatId, renderNoMatch(language))]
      : [textAction(message.chatId, renderProduct(products[0], language, requestedSize))];
  }

  await dependencies.repository.saveActions(ingested.conversation.id, actions);
  return { eventId: message.eventId, duplicate: false, actions };
}

export function detectLanguage(text: string): Language {
  if (/[\u0600-\u06ff]/.test(text)) return "ur";
  if (/\b(kya|hai|hain|mujhe|chahiye|dikhao|rang|qeemat|kitne|mein|aap)\b/i.test(text)) return "roman_ur";
  return "en";
}

function extractSize(text: string): string | undefined {
  const match = text.match(SIZE_PATTERN)?.[1]?.toLowerCase();
  const aliases: Record<string, string> = { small: "s", medium: "m", large: "l" };
  return match ? aliases[match] ?? match : undefined;
}

function textAction(recipientChatId: string, text: string): OutboundAction {
  return { actionId: randomUUID(), recipientChatId, type: "text", text };
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}