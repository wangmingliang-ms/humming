import { describe, expect, it, vi } from "vitest";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter, PermissionCardView } from "../presenter/presenter.js";
import type {
  ActionToken,
  PermissionToken,
  RequestId,
  ResponseCardId,
  ResponseId,
  ResponseToken,
  TurnId,
} from "./topic-conversation.js";
import {
  TopicConversationSession,
  type TopicConversationTokenFactory,
} from "./topic-conversation-session.js";

const logger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function sequentialTokens(): TopicConversationTokenFactory {
  const counts = new Map<string, number>();
  const next = (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return `${name}-${count}`;
  };
  return {
    turn: () => next("turn") as TurnId,
    request: () => next("request") as RequestId,
    response: () => next("response") as ResponseId,
    responseToken: () => next("response-token") as ResponseToken,
    card: () => next("card") as ResponseCardId,
    action: () => next("action") as ActionToken,
    permission: () => next("permission") as PermissionToken,
    permissionRequest: () => next("permission-request"),
  };
}

function fixture(overrides: Partial<LarkPresenter> = {}) {
  const sent: unknown[] = [];
  const patched: unknown[] = [];
  const permissions: PermissionCardView[] = [];
  const presenter = {
    sendConversationCard: vi.fn(async (_messageId, view) => {
      sent.push(view);
      return `external-card-${sent.length}`;
    }),
    updateConversationCard: vi.fn(async (_cardId, view) => {
      patched.push(view);
      return true;
    }),
    sendPermissionRequestCard: vi.fn(async (_messageId, view) => {
      permissions.push(view);
      return `permission-card-${permissions.length}`;
    }),
    expirePermissionCard: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LarkPresenter;
  const cancel = vi.fn(async () => undefined);
  const session = new TopicConversationSession({
    presenter,
    logger,
    route: { c: "chat", th: "thread" },
    tokens: sequentialTokens(),
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    onCancelResponse: cancel,
  });
  return { session, presenter, sent, patched, permissions, cancel };
}

const profile = { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" };

describe("TopicConversationSession", () => {
  it("renders B merged and C interrupting while preserving one batch", async () => {
    const { session, patched, sent } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const b = session.accept({ sourceMessageId: "message-b", content: "B", profile });
    const c = session.accept({ sourceMessageId: "message-c", content: "C", profile });
    await vi.waitFor(() => expect(session.snapshot.pendingBatch?.messages).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        session.snapshot.turns.find((turn) => turn.response.id === b.responseId)?.response.state,
      ).toEqual({ kind: "terminal", outcome: "merged" }),
    );

    expect(session.snapshot.pendingBatch?.carrierResponseId).toBe(c.responseId);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    await vi.waitFor(() =>
      expect(
        patched.some(
          (view) =>
            (view as { kind?: string; header?: string }).kind === "terminal" &&
            (view as { header?: string }).header === "merged",
        ),
      ).toBe(true),
    );
  });

  it("revokes Card Cancel immediately but waits for finishOwner to release execution", async () => {
    const { session, cancel } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    session.accept({ sourceMessageId: "message-b", content: "B", profile });
    const authority = session.snapshot.cancelAuthority;
    if (authority.kind !== "cancel") throw new Error("missing cancel authority");

    expect(
      session.consumeCancel({
        responseToken: a.responseToken,
        cardId: authority.cardId,
        actionToken: authority.token,
      }),
    ).toBe("accepted");
    expect(session.snapshot.executionOwnerResponseId).toBe(a.responseId);
    expect(session.snapshot.cancelAuthority).toEqual({ kind: "none" });
    expect(cancel).toHaveBeenCalledWith(a.responseId);

    const handoff = await session.finishOwner("cancelled");
    expect(handoff.pendingBatch).toHaveLength(1);
    expect(session.snapshot.executionOwnerResponseId).toBeNull();
  });

  it("expires Permission immediately when a new message arrives", async () => {
    const { session, presenter } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const permissionPromise = session.requestPermission(a.responseId, {
      sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await vi.waitFor(() => expect(session.snapshot.permission?.status).toBe("current"));

    session.accept({ sourceMessageId: "message-b", content: "B", profile });

    await expect(permissionPromise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(session.snapshot.permission?.status).toBe("expired");
    expect(presenter.expirePermissionCard).toHaveBeenCalled();
  });

  it("fails Response when mandatory Permission Card is not visible", async () => {
    const { session } = fixture({ sendPermissionRequestCard: vi.fn(async () => null) });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);

    await expect(
      session.requestPermission(a.responseId, {
        sessionId: "session",
        toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    const response = session.snapshot.turns.find(
      (turn) => turn.response.id === a.responseId,
    )?.response;
    expect(response?.state).toEqual({ kind: "terminal", outcome: "failed" });
    expect(response?.cards.at(-1)?.entries).toContainEqual({
      kind: "notice",
      text: "权限请求无法显示，本次执行失败。",
    });
  });
});
