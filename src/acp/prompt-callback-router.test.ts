import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { LifecycleDiagnosticEvent, LifecycleDiagnosticSink } from "./lifecycle-diagnostics.js";
import {
  PromptCallbackRouter,
  type BootstrapCallbacks,
  type PromptScopedCallbacks,
  type SessionCallbacks,
} from "./prompt-callback-router.js";
import type { PromptToken } from "../presenter/conversation-card-view.js";

function diagnosticSink(): LifecycleDiagnosticSink & { events: LifecycleDiagnosticEvent[] } {
  const events: LifecycleDiagnosticEvent[] = [];
  return { events, record: (event) => events.push(event) };
}

function sessionCallbacks(): SessionCallbacks {
  return {
    readTextFile: vi.fn(async () => ({ content: "file contents" })),
    writeTextFile: vi.fn(async () => ({})),
    onSessionInfo: vi.fn(),
    onMode: vi.fn(),
    onConfig: vi.fn(),
    onCommands: vi.fn(),
    onUsage: vi.fn(),
  };
}

function notification(update: acp.SessionUpdate): acp.SessionNotification {
  return { sessionId: "session-1", update };
}

function bootstrapCallbacks(): BootstrapCallbacks {
  return { sessionUpdate: vi.fn(async () => {}) };
}

function promptCallbacks(
  sessionUpdate: PromptScopedCallbacks["sessionUpdate"] = async () => {},
): PromptScopedCallbacks {
  return {
    sessionUpdate: vi.fn(sessionUpdate),
    requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" } })),
    cancelPendingPermissions: vi.fn(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const replayUpdates: acp.SessionUpdate[] = [
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old user" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old agent" } },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "old thought" } },
  { sessionUpdate: "plan", entries: [] },
  {
    sessionUpdate: "tool_call",
    toolCallId: "old-tool",
    title: "Old tool",
    status: "completed",
  },
  { sessionUpdate: "tool_call_update", toolCallId: "old-tool", status: "completed" },
];

const metadataUpdates: acp.SessionUpdate[] = [
  { sessionUpdate: "session_info_update", title: "Session title" },
  { sessionUpdate: "current_mode_update", currentModeId: "code" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "usage_update", used: 12, size: 100 },
];

describe("PromptCallbackRouter bootstrap routing", () => {
  it("isolates load history replay from prompt callbacks and forwards metadata by discriminant", async () => {
    const session = sessionCallbacks();
    const bootstrap = bootstrapCallbacks();
    const router = new PromptCallbackRouter(session, diagnosticSink());
    const handle = router.activateBootstrap("load", bootstrap);

    for (const update of [...replayUpdates, ...metadataUpdates]) {
      await router.sessionUpdate(notification(update));
    }

    expect(bootstrap.sessionUpdate).toHaveBeenCalledTimes(replayUpdates.length);
    expect(bootstrap.sessionUpdate).toHaveBeenCalledWith(notification(replayUpdates[0]!));
    expect(session.onSessionInfo).toHaveBeenCalledWith(metadataUpdates[0]);
    expect(session.onMode).toHaveBeenCalledWith(metadataUpdates[1]);
    expect(session.onConfig).toHaveBeenCalledWith(metadataUpdates[2]);
    expect(session.onCommands).toHaveBeenCalledWith(metadataUpdates[3]);
    expect(session.onUsage).toHaveBeenCalledWith(metadataUpdates[4]);

    router.closeBootstrap(handle);
  });

  it.each(["new", "resume"] as const)("supports the %s setup route", async (mode) => {
    const bootstrap = bootstrapCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const handle = router.activateBootstrap(mode, bootstrap);

    await router.sessionUpdate(notification(replayUpdates[1]!));

    expect(bootstrap.sessionUpdate).toHaveBeenCalledWith(notification(replayUpdates[1]!));
    router.closeBootstrap(handle);
  });

  it("forwards exactly the advertised file operations and exposes no terminal or extension methods", async () => {
    const session = sessionCallbacks();
    const router = new PromptCallbackRouter(session, diagnosticSink());
    const read = { sessionId: "session-1", path: "/tmp/input", line: 2, limit: 3 };
    const write = { sessionId: "session-1", path: "/tmp/output", content: "value" };

    await expect(router.readTextFile(read)).resolves.toEqual({ content: "file contents" });
    await expect(router.writeTextFile(write)).resolves.toEqual({});
    expect(session.readTextFile).toHaveBeenCalledWith(read);
    expect(session.writeTextFile).toHaveBeenCalledWith(write);
    expect("createTerminal" in router).toBe(false);
    expect("terminalOutput" in router).toBe(false);
    expect("extMethod" in router).toBe(false);
    expect("extNotification" in router).toBe(false);
  });
});

describe("PromptCallbackRouter active routing", () => {
  it("captures the active route synchronously when a callback enters", async () => {
    const entered = deferred();
    const release = deferred();
    const a = promptCallbacks(async () => {
      entered.resolve();
      await release.promise;
    });
    const b = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const aHandle = router.activate("prompt-a" as PromptToken, a);

    const inFlight = router.sessionUpdate(notification(replayUpdates[1]!));
    await entered.promise;
    router.close(aHandle);
    router.activate("prompt-b" as PromptToken, b);
    release.resolve();
    await inFlight;

    expect(a.sessionUpdate).toHaveBeenCalledOnce();
    expect(b.sessionUpdate).not.toHaveBeenCalled();
  });

  it("captures a permission route before a later route is activated", async () => {
    const release = deferred();
    const a = promptCallbacks();
    vi.mocked(a.requestPermission).mockImplementation(async () => {
      await release.promise;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    const b = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const aHandle = router.activate("prompt-a" as PromptToken, a);
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Tool" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    };

    const inFlight = router.requestPermission(request);
    router.close(aHandle);
    router.activate("prompt-b" as PromptToken, b);
    release.resolve();

    await expect(inFlight).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(a.requestPermission).toHaveBeenCalledWith(request);
    expect(b.requestPermission).not.toHaveBeenCalled();
  });

  it("quarantines an update that enters after the prompt response boundary", async () => {
    const sink = diagnosticSink();
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), sink);
    const handle = router.activate("prompt-a" as PromptToken, callbacks);
    router.close(handle);

    await expect(router.sessionUpdate(notification(replayUpdates[1]!))).rejects.toThrow(
      "closed prompt route",
    );

    expect(callbacks.sessionUpdate).not.toHaveBeenCalled();
    expect(router.isConnectionHealthy()).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({
      category: "router",
      operation: "session_update",
      outcome: "quarantined",
    });
  });

  it("cancels and quarantines a permission request that enters after close", async () => {
    const sink = diagnosticSink();
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), sink);
    const handle = router.activate("prompt-a" as PromptToken, callbacks);
    router.close(handle);

    await expect(
      router.requestPermission({
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Tool" },
        options: [],
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    expect(callbacks.requestPermission).not.toHaveBeenCalled();
    expect(router.isConnectionHealthy()).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({
      category: "router",
      operation: "permission_request",
      outcome: "cancelled",
    });
  });

  it("retains the route during cancel so trailing updates are accepted", async () => {
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const handle = router.activate("prompt-a" as PromptToken, callbacks);

    router.cancel(handle);
    await router.sessionUpdate(notification(replayUpdates[1]!));

    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledOnce();
    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledWith("prompt_cancelled");
    expect(callbacks.sessionUpdate).toHaveBeenCalledOnce();
    expect(router.isConnectionHealthy()).toBe(true);
  });

  it("cancels pending permissions exactly once across cancel and response close", () => {
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const handle = router.activate("prompt-a" as PromptToken, callbacks);

    router.cancel(handle);
    router.cancel(handle);
    router.close(handle);

    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledOnce();
  });

  it("cancels pending permissions on connection shutdown without reassigning the route", () => {
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    router.activate("prompt-a" as PromptToken, callbacks);

    router.connectionShutdown();
    router.connectionShutdown();

    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledOnce();
    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledWith("connection_shutdown");
  });

  it("refuses to activate a new prompt after quarantine", async () => {
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    await expect(router.sessionUpdate(notification(replayUpdates[1]!))).rejects.toThrow();

    expect(() => router.activate("prompt-b" as PromptToken, promptCallbacks())).toThrow(
      "unhealthy",
    );
  });

  it("runs a prompt through the response boundary and closes the route on cancellation", async () => {
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const response = Promise.resolve<acp.PromptResponse>({ stopReason: "cancelled" });

    await expect(
      router.runPrompt("prompt-a" as PromptToken, callbacks, () => response),
    ).resolves.toEqual({ stopReason: "cancelled" });

    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledOnce();
    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledWith("route_closed");
    await expect(router.sessionUpdate(notification(replayUpdates[1]!))).rejects.toThrow();
  });

  it("closes the route after a rejected prompt response", async () => {
    const callbacks = promptCallbacks();
    const router = new PromptCallbackRouter(sessionCallbacks(), diagnosticSink());
    const failure = new Error("prompt failed");

    await expect(
      router.runPrompt("prompt-a" as PromptToken, callbacks, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(callbacks.cancelPendingPermissions).toHaveBeenCalledWith("route_closed");
    await expect(router.sessionUpdate(notification(replayUpdates[1]!))).rejects.toThrow();
  });
});
