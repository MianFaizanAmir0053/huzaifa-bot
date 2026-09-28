import {
  BrainResponseSchema,
  MediaUploadGrantSchema,
  type InboundMessage,
  type MediaUploadGrant,
  type MediaUploadRequest,
} from "@huzaifa/contracts";
import { createGatewaySignature } from "./signature.js";

export type BrainClientOptions = {
  baseUrl: string;
  hmacSecret: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
};

export class BrainClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: BrainClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async processMessage(message: InboundMessage) {
    const response = await this.signedRequest("/api/gateway/messages", message);
    return BrainResponseSchema.parse(await response.json());
  }

  async createMediaUpload(request: MediaUploadRequest): Promise<MediaUploadGrant> {
    const response = await this.signedRequest("/api/gateway/media-upload", request);
    return MediaUploadGrantSchema.parse(await response.json());
  }

  async reportDeliveries(acknowledgements: DeliveryAcknowledgement[]): Promise<void> {
    const report = DeliveryReportSchema.parse({ acknowledgements });
    await this.signedRequest("/api/gateway/deliveries", report);
  }

  async uploadMedia(grant: MediaUploadGrant, bytes: Uint8Array, mimeType: MediaUploadRequest["mimeType"]): Promise<void> {
    const uploadUrl = new URL(grant.signedUrl);
    if (uploadUrl.protocol !== "https:" || !uploadUrl.pathname.includes("/storage/v1/object/upload/sign/inbound-media/")) {
      throw new Error("Brain returned an invalid media upload URL");
    }

    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.fetchImplementation(uploadUrl, {
      method: "PUT",
      headers: {
        "cache-control": "max-age=0",
        "content-type": mimeType,
        "x-upsert": "false",
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Media upload failed with status ${response.status}`);
  }

  private async signedRequest(path: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const response = await this.fetchImplementation(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-huzaifa-timestamp": timestamp,
        "x-huzaifa-signature": createGatewaySignature(body, timestamp, this.options.hmacSecret),
      },
      body,
      signal: Ab