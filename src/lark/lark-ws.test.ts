import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LarkLogger } from "../logger/logger.js";

const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  start: vi.fn(),
  close: vi.fn(),
  getConnectionStatus: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  LoggerLevel: { info: "info" },
  WSClient: class {
    constructor(options: unknown) {
      sdkMocks.constructorOptions.push(options);
    }

    readonly start = sdkMocks.start;
    readonly close = sdkMocks.close;
    readonly getConnectionStatus = sdkMocks.getConnectionStatus;
  },
  EventDispatcher: class {
    register(): this {
      return this;
    }
  },
  normalizeCardAction: vi.fn(),
}));

import { LarkWsConnection } from "./lark-ws.js";

const loggerMocks = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const recordingLogger: LarkLogger = {
  debug: loggerMocks.debug,
  info: loggerMocks.info,
  warn: loggerMocks.warn,
  error: loggerMocks.error,
  child(): LarkLogger {
    return recordingLogger;
  },
};

type CapturedWsOptions = {
  readonly onReady?: () => void;
  readonly onError?: (err: Error) => void;
  readonly onReconnecting?: () => void;
  readonly onReconnected?: () => void;
};

function createConnection(): LarkWsConnection {
  return new LarkWsConnection({
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
    logger: recordingLogger,
    onMessage: vi.fn(),
    onCardAction: vi.fn(),
  });
}

function capturedOptions(): CapturedWsOptions {
  return sdkMocks.constructorOptions.at(-1) as CapturedWsOptions;
}

beforeEach(() => {
  sdkMocks.constructorOptions.length = 0;
  sdkMocks.start.mockReset();
  sdkMocks.close.mockReset();
  sdkMocks.getConnectionStatus.mockReset();
  loggerMocks.debug.mockReset();
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
});

describe("LarkWsConnection liveness", () => {
  it("bounds both the WebSocket handshake and the post-ping liveness window", () => {
    createConnection();

    expect(sdkMocks.constructorOptions).toHaveLength(1);
    expect(sdkMocks.constructorOptions[0]).toMatchObject({
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 15 },
    });
  });

  it("reports connected only after the SDK confirms readiness", () => {
    const connection = createConnection();

    connection.start();

    expect(sdkMocks.start).toHaveBeenCalledOnce();
    expect(loggerMocks.info).toHaveBeenCalledWith("connecting to Lark via WebSocket");
    expect(loggerMocks.info).not.toHaveBeenCalledWith("WebSocket connected; listening for events");

    capturedOptions().onReady?.();

    expect(loggerMocks.info).toHaveBeenCalledWith("WebSocket connected; listening for events");
  });

  it("reports when the SDK enters its reconnect loop", () => {
    createConnection();

    capturedOptions().onReconnecting?.();

    expect(loggerMocks.warn).toHaveBeenCalledWith("Lark WebSocket disconnected; reconnecting");
  });

  it("reports when the SDK re-establishes the event stream", () => {
    createConnection();

    capturedOptions().onReconnected?.();

    expect(loggerMocks.info).toHaveBeenCalledWith(
      "Lark WebSocket reconnected; listening for events",
    );
  });

  it("reports a terminal SDK connection failure with its cause", () => {
    createConnection();
    const error = new Error("reconnect exhausted");

    capturedOptions().onError?.(error);

    expect(loggerMocks.error).toHaveBeenCalledWith({ err: error }, "Lark WebSocket failed");
  });

  it("force-closes the SDK client so timers and reconnect loops cannot survive shutdown", () => {
    const connection = createConnection();

    connection.close();

    expect(sdkMocks.close).toHaveBeenCalledWith({ force: true });
  });

  it("exposes the SDK connection state without changing it", () => {
    sdkMocks.getConnectionStatus.mockReturnValue({
      state: "reconnecting",
      reconnectAttempts: 2,
      lastConnectTime: 123,
    });
    const connection = createConnection();

    expect(connection.getConnectionStatus()).toEqual({
      state: "reconnecting",
      reconnectAttempts: 2,
      lastConnectTime: 123,
    });
  });
});
