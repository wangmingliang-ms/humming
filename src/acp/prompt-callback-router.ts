import type * as acp from "@agentclientprotocol/sdk";
import type { PromptToken } from "../presenter/conversation-card-view.js";
import type {
  DiagnosticCorrelation,
  LifecycleDiagnosticSink,
  RouterLifecycleDiagnostic,
} from "./lifecycle-diagnostics.js";

export interface SessionCallbacks {
  readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  onSessionInfo(update: acp.SessionInfoUpdate): void;
  onMode(update: acp.CurrentModeUpdate): void;
  onConfig(update: acp.ConfigOptionUpdate): void;
  onCommands(update: acp.AvailableCommandsUpdate): void;
  onUsage(update: acp.UsageUpdate): void;
}

export interface BootstrapCallbacks {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
}

export interface PromptScopedCallbacks {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  cancelPendingPermissions(
    reason: "prompt_cancelled" | "route_closed" | "connection_shutdown",
  ): void;
}

declare const bootstrapRouteHandleBrand: unique symbol;
declare const promptRouteHandleBrand: unique symbol;

export type BootstrapRouteHandle = object & { readonly [bootstrapRouteHandleBrand]: true };
export type PromptRouteHandle = object & { readonly [promptRouteHandleBrand]: true };

interface BootstrapRoute {
  readonly phase: "bootstrap";
  readonly mode: "new" | "load" | "resume";
  readonly callbacks: BootstrapCallbacks;
  readonly handle: BootstrapRouteHandle;
}

interface ActiveRoute {
  readonly phase: "active";
  readonly promptToken: PromptToken;
  readonly callbacks: PromptScopedCallbacks;
  readonly handle: PromptRouteHandle;
  permissionsCancelled: boolean;
}

type Route =
  | { readonly phase: "idle" }
  | BootstrapRoute
  | ActiveRoute
  | { readonly phase: "closed"; readonly promptToken: PromptToken };

const ROUTER_CORRELATION: DiagnosticCorrelation = {
  runtimeSequence: 0,
  promptSequence: 0,
  segmentSequence: null,
  ownerSequence: null,
};

function isSessionMetadata(
  update: acp.SessionUpdate,
): update is
  | (acp.SessionInfoUpdate & { sessionUpdate: "session_info_update" })
  | (acp.CurrentModeUpdate & { sessionUpdate: "current_mode_update" })
  | (acp.ConfigOptionUpdate & { sessionUpdate: "config_option_update" })
  | (acp.AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" })
  | (acp.UsageUpdate & { sessionUpdate: "usage_update" }) {
  switch (update.sessionUpdate) {
    case "session_info_update":
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update":
    case "usage_update":
      return true;
    default:
      return false;
  }
}

export class PromptCallbackRouter implements acp.Client {
  private route: Route = { phase: "idle" };
  private healthy = true;

  constructor(
    private readonly session: SessionCallbacks,
    private readonly diagnostics: LifecycleDiagnosticSink,
  ) {}

  activateBootstrap(
    mode: "new" | "load" | "resume",
    callbacks: BootstrapCallbacks,
  ): BootstrapRouteHandle {
    const handle = {} as BootstrapRouteHandle;
    this.route = { phase: "bootstrap", mode, callbacks, handle };
    this.record("route_activate", "accepted");
    return handle;
  }

  closeBootstrap(handle: BootstrapRouteHandle): void {
    if (this.route.phase !== "bootstrap" || this.route.handle !== handle) return;
    this.route = { phase: "idle" };
    this.record("route_close", "accepted");
  }

  activate(promptToken: PromptToken, callbacks: PromptScopedCallbacks): PromptRouteHandle {
    if (!this.healthy) throw new Error("cannot activate a prompt on an unhealthy ACP connection");
    if (this.route.phase === "active" || this.route.phase === "bootstrap") {
      throw new Error("cannot replace an open ACP callback route");
    }
    const handle = {} as PromptRouteHandle;
    this.route = { phase: "active", promptToken, callbacks, handle, permissionsCancelled: false };
    this.record("route_activate", "accepted");
    return handle;
  }

  close(handle: PromptRouteHandle): void {
    if (this.route.phase !== "active" || this.route.handle !== handle) return;
    const route = this.route;
    this.route = { phase: "closed", promptToken: route.promptToken };
    this.cancelRoutePermissions(route, "route_closed");
    this.record("route_close", "accepted");
  }

  async runPrompt<T extends acp.PromptResponse>(
    promptToken: PromptToken,
    callbacks: PromptScopedCallbacks,
    prompt: () => Promise<T>,
  ): Promise<T> {
    const handle = this.activate(promptToken, callbacks);
    try {
      return await prompt();
    } finally {
      this.close(handle);
    }
  }

  cancel(handle: PromptRouteHandle): void {
    if (this.route.phase !== "active" || this.route.handle !== handle) return;
    this.cancelRoutePermissions(this.route, "prompt_cancelled");
  }

  connectionShutdown(): void {
    if (this.route.phase === "active") {
      const route = this.route;
      this.route = { phase: "closed", promptToken: route.promptToken };
      this.cancelRoutePermissions(route, "connection_shutdown");
    } else if (this.route.phase === "bootstrap") {
      this.route = { phase: "idle" };
    }
    this.healthy = false;
  }

  isConnectionHealthy(): boolean {
    return this.healthy;
  }

  readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    return this.session.readTextFile(params);
  }

  writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    return this.session.writeTextFile(params);
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const route = this.route;
    if (route.phase === "active") {
      this.record("permission_request", "accepted");
      return route.callbacks.requestPermission(params);
    }
    this.healthy = false;
    this.record("permission_request", "cancelled");
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    if (isSessionMetadata(update)) {
      switch (update.sessionUpdate) {
        case "session_info_update":
          this.session.onSessionInfo(update);
          break;
        case "current_mode_update":
          this.session.onMode(update);
          break;
        case "config_option_update":
          this.session.onConfig(update);
          break;
        case "available_commands_update":
          this.session.onCommands(update);
          break;
        case "usage_update":
          this.session.onUsage(update);
          break;
      }
      this.record("session_update", "accepted");
      return;
    }

    const route = this.route;
    if (route.phase === "bootstrap") {
      this.record("bootstrap_update", "accepted");
      await route.callbacks.sessionUpdate(params);
      return;
    }
    if (route.phase === "active") {
      this.record("session_update", "accepted");
      await route.callbacks.sessionUpdate(params);
      return;
    }
    this.healthy = false;
    this.record("session_update", "quarantined");
    throw new Error(
      "ACP session update entered without an active or bootstrap route: closed prompt route",
    );
  }

  private record(
    operation: RouterLifecycleDiagnostic["operation"],
    outcome: RouterLifecycleDiagnostic["outcome"],
  ): void {
    this.diagnostics.record({
      category: "router",
      correlation: ROUTER_CORRELATION,
      operation,
      outcome,
    });
  }

  private cancelRoutePermissions(
    route: ActiveRoute,
    reason: Parameters<PromptScopedCallbacks["cancelPendingPermissions"]>[0],
  ): void {
    if (route.permissionsCancelled) return;
    route.permissionsCancelled = true;
    route.callbacks.cancelPendingPermissions(reason);
  }
}
