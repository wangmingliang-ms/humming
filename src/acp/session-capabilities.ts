import type * as acp from "@agentclientprotocol/sdk/unstable";

/** Legacy ACP model selector still exposed by agents such as Codex ACP. */
export interface SessionModelState {
  readonly availableModels: readonly {
    readonly modelId: string;
    readonly name: string;
    readonly description?: string | null;
  }[];
  readonly currentModelId: string;
}

export interface SessionRuntimeCapabilities {
  readonly models?: SessionModelState | null;
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
}

export function capabilitiesFromSessionResponse(response: {
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
}): SessionRuntimeCapabilities {
  // ACP SDK 1.x removed the legacy `models` type, but existing agents still
  // include that field in their session response. Read and validate it here.
  const models: unknown = Reflect.get(response, "models");
  return {
    ...(isSessionModelState(models) ? { models } : {}),
    ...(response.modes !== undefined ? { modes: response.modes } : {}),
    ...(response.configOptions !== undefined ? { configOptions: response.configOptions } : {}),
  };
}

function isSessionModelState(value: unknown): value is SessionModelState {
  if (typeof value !== "object" || value === null) return false;
  const models: unknown = Reflect.get(value, "availableModels");
  const currentModelId: unknown = Reflect.get(value, "currentModelId");
  return (
    typeof currentModelId === "string" &&
    Array.isArray(models) &&
    models.every(
      (model: unknown) =>
        typeof model === "object" &&
        model !== null &&
        typeof Reflect.get(model, "modelId") === "string" &&
        typeof Reflect.get(model, "name") === "string" &&
        (Reflect.get(model, "description") === undefined ||
          Reflect.get(model, "description") === null ||
          typeof Reflect.get(model, "description") === "string"),
    )
  );
}
