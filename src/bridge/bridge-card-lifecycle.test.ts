import { describe, expect, it, vi } from "vitest";
import type { BindingStore } from "../binding-store/binding-store.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
import { LarkBridge } from "./bridge.js";

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function makeBridge(): LarkBridge {
  return new LarkBridge({
    lark: { appId: "test", appSecret: "test" },
    agent: {
      resolver: () => ({ command: "test", args: [], label: "test" }),
    },
    bindingStore: {} as BindingStore,
    sessionStore: {} as SessionStore,
    presenter: {} as LarkPresenter,
    logger,
  });
}

function dispatchCardAction(bridge: LarkBridge, value: object): void {
  const testable = bridge as unknown as {
    handleCardAction(event: {
      readonly action: { readonly value: object };
      readonly messageId: string;
    }): void;
  };
  testable.handleCardAction({ action: { value }, messageId: "message" });
}

describe("LarkBridge Cancel card compatibility", () => {
  it("rejects a versioned Cancel action before runtime lookup", () => {
    const bridge = makeBridge();
    const get = vi.fn();
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, { v: 2, cancel: true, c: "chat", th: "topic" });

    expect(get).not.toHaveBeenCalled();
  });

  it("still cancels from an unversioned legacy action", async () => {
    const bridge = makeBridge();
    const cancel = vi.fn(async () => {});
    const get = vi.fn(() => ({ cancel }));
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, { cancel: true, c: "chat", th: "topic" });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
