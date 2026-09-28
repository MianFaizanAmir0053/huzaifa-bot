export type GatewayMedia = {
  mimeType: string;
  dataBase64: string;
  fileName?: string;
};

export type TransportMessage = {
  id: string;
  chatId: string;
  displayName?: string;
  occurredAt: string;
  fromMe: boolean;
  isGroup: boolean;
  text?: string;
  media?: GatewayMedia;
};

export type SessionSnapshot = {
  state: "starting" | "qr_pending" | "ready" | "disconnected" | "error";
  qrDataUrl?: string;
  detail?: string;
};

export type MessageHandler = (message: TransportMessage) => Promise<void>;

export interface WhatsAppTransport {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendText(chatId: string, text: string): Promise<string>;
  getSessionSnapshot(): SessionSnapshot;
}