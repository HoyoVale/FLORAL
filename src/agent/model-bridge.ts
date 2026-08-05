export type ModelWireApi = "responses" | "chat-completions";

export interface ModelBridgeDescriptor {
  readonly name: string;
  readonly sourceWireApi: ModelWireApi;
  readonly targetWireApi: ModelWireApi;
}

/**
 * Reserved boundary for a future Responses API ↔ provider protocol adapter.
 * Phase 1 deliberately defines the seam without implementing or enabling a bridge.
 */
export interface ModelBridge extends ModelBridgeDescriptor {
  translateRequest(request: unknown): Promise<unknown>;
  translateResponse(response: unknown): Promise<unknown>;
}
