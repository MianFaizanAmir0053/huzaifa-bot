import QRCode from "qrcode";
import pkg, { type Chat, type Message } from "whatsapp-web.js";
import { fetchImage } from "./image-fetch.js";
import { phoneFromWid, serializeMessageId } from "./message-id.js";
import { SentRegistry } from "./sent-registry.js";
import { NotSentError, type MessageHandler, type OwnerMessageHandler, type SessionSnapshot, type TransportOwnerMessage, type WhatsAppTransport } from "./transport.js";

const { Client, LocalAuth, MessageMedia } = pkg;
type WebClient = InstanceType<typeof Client>;

// Only plain text and photos reach the brain. Voice notes, stickers, video, documents etc. are ignored
// before any download, so large media never enters gateway memory.
const SUPPORTED_TYPES = new Set(["chat", "image"]);
// Anything the owner sends that a customer sees means a person is handling the chat, voice notes included.
const OWNER_PLACEHOLDERS: Record<string, string> = {
  ptt: "[voice note]",
  audio: "[audio]",
  video: "[video]",
  document: "[document]",
  sticker: "[sticker]",
  location: "[location]",
  vcard: "[contact]",
  multi_vcard: "[contact]",
};
const NON_CUSTOMER_CHAT = /@(g\.us|broadcast|newsletter)$/;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
// Known whatsapp-web.js failure: a restored session reaches "authenticated" but never "ready"
// (seen after the process was killed without closing Chromium). A fresh browser on the same session fixes it.
const READY_WATCHDOG_MS = 120_000;
const MAX_STUCK_RESTARTS = 3;
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export type TransportLogger = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export class WhatsAppWebTransport implements WhatsAppTransport {
  private readonly handlers = new Set<MessageHandler>();
  private readonly ownerHandlers = new Set<OwnerMessageHandler>();
  private readonly sentRegistry = new SentRegistry();
  private snapshot: SessionSnapshot = { state: "starting", updatedAt: new Date().toISOString() };
  private client: WebClient;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private restarting = false;
  // Bumped for every new client; events from a replaced client are ignored so they can't overwrite the status.
  private generation = 0;
  private readyWatchdog: NodeJS.Timeout | undefined;
  private stuckRestarts = 0;
  // Per chat, the preparation of the latest incoming message (keeps arrival order).
  private readonly incomingChains = new Map<string, Promise<void>>();

  constructor(
    private readonly authPath: string,
    private readonly logger: TransportLogger,
    private readonly chromiumPath?: string,
    private readonly userAgent: string = DEFAULT_USER_AGENT,
  ) {
    this.client = this.createClient();
  }

  // Alternative to the QR: WhatsApp shows "Link with phone number instead"; this returns the 8-character code to type there.
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (this.snapshot.state !== "qr_pending") throw new Error(`Pairing is only possible while waiting to link (now ${this.snapshot.state})`);
    const code = await this.client.requestPairingCode(phoneNumber, true);
    this.setSnapshot({ ...this.snapshot, state: "qr_pending", pairingCode: code });
    return code;
  }

  private setSnapshot(next: Omit<SessionSnapshot, "updatedAt" | "reconnectAttempts">) {
    this.snapshot = { ...next, updatedAt: new Date().toISOString(), reconnectAttempts: this.reconnectAttempts };
  }

  private createClient(): WebClient {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      // The library default claims Chrome 101 on macOS 10.14; WhatsApp refuses to link such outdated browsers.
      userAgent: this.userAgent,
      puppeteer: {
        headless: true,
        executablePath: this.chromiumPath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"],
      },
    });

    client.on("qr", async (qr) => {
      const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (!current()) return;
      this.setSnapshot({ state: "qr_pending", qrDataUrl, pairingCode: this.snapshot.pairingCode });
    });
    client.on("authenticated", () => {
      if (!current()) return;
      this.setSnapshot({ state: "authenticated" });
      if (!this.readyWatchdog) this.readyWatchdog = setTimeout(() => this.onReadyTimeout(generation), READY_WATCHDOG_MS);
    });
    client.on("ready", () => {
      if (!current()) return;
      clearTimeout(this.readyWatchdog);
      this.readyWatchdog = undefined;
      this.stuckRestarts = 0;
      this.reconnectAttempts = 0;
      this.setSnapshot({ state: "ready", phoneNumber: client.info?.wid?.user });
      this.logger.info({}, "WhatsApp session ready");
    });
    client.on("auth_failure", (detail) => {
      if (!current()) return;
      this.setSnapshot({ state: "error", detail: `Authentication failed: ${detail}` });
      this.logger.error({ detail }, "WhatsApp authentication failed");
    });
    client.on("disconnected", (reason) => {
      if (!current()) return;
      this.setSnapshot({ state: "disconnected", detail: String(reason) });
      this.logger.warn({ reason: String(reason) }, "WhatsApp disconnected");
      this.scheduleReconnect();
    });
    client.on("message", (message) => {
      if (!current()) return;
      // Preparing a message (photo download, contact lookup) takes varying time; chaining per chat keeps
      // a slow photo from being overtaken by the text sent right after it.
      const key = message.from;
      const previous = this.incomingChains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleIncoming(message))
        .catch((error: unknown) => this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Incoming message handling failed"))
        .finally(() => {
          if (this.incomingChains.get(key) === next) this.incomingChains.delete(key);
        });
      this.incomingChains.set(key, next);
    });
    // Fires for every message this account sends, from the gateway or from the owner's phone and other devices.
    client.on("message_create", (message) => {
      if (!current() || !message.fromMe) return;
      void this.handleOwnMessage(message).catch((error: unknown) =>
        this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Owner message handling failed"),
      );
    });
    return client;
  }

  private async handleOwnMessage(message: Message): Promise<void> {
    const chatId = message.to;
    const placeholder = OWNER_PLACEHOLDERS[message.type];
    if ((!SUPPORTED_TYPES.has(message.type) && !placeholder) || !chatId || NON_CUSTOMER_CHAT.test(chatId)) return;
    const id = serializeMessageId(message.id);
    if (!id) return;
    const body = message.type === "chat" || message.type === "image" ? (message.body ?? "") : "";
    if (this.sentRegistry.isOwnSend(id, [chatId], body)) return;
    const alternateChatIds = await this.resolveAlternateChatIds(chatId);
    // WhatsApp can file our own send under the contact's other id; checked after the lookup, by which time
    // the send has usually returned its id as well.
    if (this.sentRegistry.isOwnSend(id, alternateChatIds, body)) return;

    const ownerMessage: TransportOwnerMessage = {
      id,
      chatId,
      alternateChatIds,
      occurredAt: occurredAt(message),
      type: message.type === "image" ? "image" : "text",
      text: body || placeholder || undefined,
    };
    await Promise.allSettled([...this.ownerHandlers].map((handler) => handler(ownerMessage)));
  }

  // Only successful lookups are cached: a missed alternate id can make the brain miss the owner's takeover.
  private readonly alternatesByChat = new Map<string, string[]>();
  private async resolveAlternateChatIds(chatId: string): Promise<string[]> {
    const cached = this.alternatesByChat.get(chatId);
    if (cached) return cached;
    if (!/@(c\.us|lid)$/.test(chatId)) return [];
    const [mapping] = await withTimeout(this.client.getContactLidAndPhone([chatId]), PAGE_CALL_TIMEOUT_MS, []);
    const alternates = [mapping?.lid, mapping?.pn].filter((wid): wid is string => typeof wid === "string" && wid !== "" && wid !== chatId);
    if (alternates.length) {
      if (this.alternatesByChat.size > 5_000) this.alternatesByChat.clear();
      this.alternatesByChat.set(chatId, alternates);
    }
    return alternates;
  }

  private async handleIncoming(message: Message): Promise<void> {
    if (message.fromMe || !SUPPORTED_TYPES.has(message.type) || NON_CUSTOMER_CHAT.test(message.from)) return;

    let media;
    if (message.type === "image" && message.hasMedia) {
      const downloaded = await withTimeout(message.downloadMedia(), MEDIA_DOWNLOAD_TIMEOUT_MS, undefined);
      // base64 is ~4/3 of the byte size; skip oversized payloads before decoding.
      if (downloaded?.data && downloaded.data.length * 0.75 <= MAX_DOWNLOAD_BYTES) {
        media = { mimeType: downloaded.mimetype, dataBase64: downloaded.data, fileName: downloaded.filename ?? undefined };
      }
    }
    const id = serializeMessageId(message.id);
    if (!id) {
      this.logger.warn({ type: message.type }, "Incoming message without a usable id ignored");
      return;
    }
    const contact = await withTimeout(message.getContact(), PAGE_CALL_TIMEOUT_MS, undefined);

    const transportMessage = {
      id,
      // Always reply to the id WhatsApp gave us (it may be a privacy "@lid" id rather than a phone number).
      chatId: message.from,
      phoneNumber: await this.resolvePhoneNumber(message.from),
      displayName: contact?.pushname || contact?.name || undefined,
      occurredAt: occurredAt(message),
      fromMe: false,
      isGroup: false,
      text: message.body || undefined,
      media,
    };
    // Hand over without waiting for the answer: the per-chat chain only orders preparation, and waiting here
    // would hold the next message back until this whole turn was answered (no burst merging).
    for (const handler of this.handlers) {
      void handler(transportMessage).catch((error: unknown) =>
        this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Message handler failed"),
      );
    }
  }

  // WhatsApp increasingly hides numbers behind "@lid" ids. Look the real number up (cached) so the owner
  // gets a tap-to-chat link and a visible number; never required for replying.
  private readonly phoneByLid = new Map<string, string | undefined>();
  private async resolvePhoneNumber(chatId: string): Promise<string | undefined> {
    const direct = phoneFromWid(chatId);
    if (direct || !chatId.endsWith("@lid")) return direct;
    if (this.phoneByLid.has(chatId)) return this.phoneByLid.get(chatId);
    const lookup = await withTimeout(
      this.client.getContactLidAndPhone([chatId]).then((mappings) => ({ mappings })),
      PAGE_CALL_TIMEOUT_MS,
      null,
    );
    // A lookup that failed or hung isn't an answer: try again with the next message instead of caching "no number".
    if (!lookup) return undefined;
    const phone = phoneFromWid(lookup.mappings[0]?.pn);
    if (this.phoneByLid.size > 5_000) this.phoneByLid.clear();
    this.phoneByLid.set(chatId, phone);
    return phone;
  }

  private onReadyTimeout(generation: number) {
    this.readyWatchdog = undefined;
    if (generation !== this.generation || this.snapshot.state !== "authenticated" || this.shuttingDown) return;
    this.stuckRestarts += 1;
    if (this.stuckRestarts > MAX_STUCK_RESTARTS) {
      this.setSnapshot({ state: "error", detail: "WhatsApp stays stuck after login. Unlink the number and scan a new QR code." });
      this.logger.error({ attempts: this.stuckRestarts - 1 }, "WhatsApp session restore keeps failing; relink required");
      return;
    }
    this.logger.warn({ attempt: this.stuckRestarts }, "WhatsApp stuck after authentication; restarting browser");
    void this.reinitialize().catch((error: unknown) =>
      this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "Restart after stuck login failed"),
    );
  }

  private scheduleReconnect() {
    if (this.shuttingDown || this.restarting || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempts += 1;
    this.logger.info({ delayMs: delay, attempt: this.reconnectAttempts }, "Scheduling WhatsApp reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reinitialize().catch((error: unknown) => {
        this.logger.error({ error: error instanceof Error ? error.message : String(error) }, "WhatsApp reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  async initialize(): Promise<void> {
    this.setSnapshot({ state: "starting" });
    const client = this.client;
    try {
      await client.initialize();
    } catch (error) {
      // A half-initialized client can still show a QR that will never link (e.g. WhatsApp reloaded the page
      // mid-injection: "detached Frame"). Throw it away and start clean.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error({ detail }, "WhatsApp client failed to start; will retry with a fresh browser");
      if (client === this.client) {
        this.generation += 1;
        await this.teardown(client);
        this.setSnapshot({ state: "error", detail });
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  // Tears down the browser and starts a fresh client (new QR if the session was logged out).
  async reinitialize(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.generation += 1;
      await this.teardown(this.client);
      this.client = this.createClient();
    } finally {
      this.restarting = false;
    }
    await this.initialize();
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.reconnectTimer);
    await this.teardown(this.client);
  }

  // Close the browser for certain. Two Chromiums on the same session folder crash each other ("Target closed").
  private async teardown(client: WebClient): Promise<void> {
    clearTimeout(this.readyWatchdog);
    this.readyWatchdog = undefined;
    await Promise.race([client.destroy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    const browserProcess = (client as unknown as { pupBrowser?: { process(): { exitCode: number | null; kill(signal: string): boolean } | null } }).pupBrowser?.process();
    if (browserProcess && browserProcess.exitCode === null) browserProcess.kill("SIGKILL");
    // Give Chromium a moment to release its profile lock before a new one starts.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  async logout(): Promise<void> {
    this.restarting = true;
    try {
      await this.client.logout();
    } finally {
      this.restarting = false;
    }
    this.setSnapshot({ state: "disconnected", detail: "Logged out" });
    // Start again so a new QR is available for relinking.
    await this.reinitialize();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  onOwnerMessage(handler: OwnerMessageHandler): void {
    this.ownerHandlers.add(handler);
  }

  async sendText(chatId: string, text: string): Promise<string> {
    if (this.snapshot.state !== "ready") throw new NotSentError(`WhatsApp not ready (${this.snapshot.state})`);
    this.sentRegistry.expect(chatId, text);
    return this.sentId(await this.client.sendMessage(chatId, text));
  }

  async sendImage(chatId: string, url: string, caption?: string): Promise<string> {
    if (this.snapshot.state !== "ready") throw new NotSentError(`WhatsApp not ready (${this.snapshot.state})`);
    const image = await fetchImage(url).catch((error: unknown) => {
      throw new NotSentError(`Photo download failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const media = new MessageMedia(image.mimeType, image.dataBase64, image.fileName);
    this.sentRegistry.expect(chatId, caption ?? "");
    return this.sentId(await this.client.sendMessage(chatId, media, caption ? { caption } : {}));
  }

  // Never throw after a successful send: the caller would retry and the customer would get the message twice.
  private sentId(sent: Message | undefined): string {
    const id = serializeMessageId(sent?.id) ?? "";
    if (id) this.sentRegistry.remember(id);
    return id;
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    if (this.snapshot.state !== "ready") return;
    try {
      // Typed as always resolving a chat, but yields undefined for unknown ids.
      const chat: Chat | undefined = await this.client.getChatById(chatId);
      if (typing) await chat?.sendStateTyping();
      else await chat?.clearState();
    } catch {
      // Cosmetic only; a reply must never wait on or fail because of the typing indicator.
    }
  }

  getSessionSnapshot(): SessionSnapshot {
    return this.snapshot;
  }
}

// Page calls (contact lookup, photo download) that hang would otherwise hold the chat's later messages until
// Puppeteer's own 180 s protocol timeout. A failure or timeout resolves to `fallback`.
const PAGE_CALL_TIMEOUT_MS = 15_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

function occurredAt(message: Message): string {
  // Locally created messages can lack a timestamp; an invalid date would throw and drop the message.
  return (message.timestamp > 0 ? new Date(message.timestamp * 1_000) : new Date()).toISOString();
}
