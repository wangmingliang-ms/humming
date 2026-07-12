import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionMode } from "../acp/humming-client.js";
import type { LarkLogger } from "../logger/logger.js";
import {
  CARD_MARKDOWN_ROTATION_BYTE_LIMIT,
  splitUtf8,
  utf8PartsByteLength,
} from "../presenter/card-text-budget.js";
import type {
  CardRoute,
  PermissionToken as WirePermissionToken,
  PromptToken,
} from "../presenter/conversation-card-view.js";
import type { LarkPresenter, PermissionCardView, SessionCardMeta } from "../presenter/presenter.js";
import { ConversationCardViewMapper } from "./conversation-card-view-mapper.js";
import {
  ResponseCardProjector,
  TopicConversation,
  type ActionToken,
  type PermissionToken,
  type RequestId,
  type RequestMessage,
  type ResponseCardId,
  type ResponseId,
  type ResponseToken,
  type TerminalOutcome,
  type TimelineEntry,
  type TopicConversationSnapshot,
  type TurnId,
} from "./topic-conversation.js";

export interface TopicConversationTokenFactory {
  turn(): TurnId;
  request(): RequestId;
  response(): ResponseId;
  responseToken(): ResponseToken;
  card(): ResponseCardId;
  action(): ActionToken;
  permission(): PermissionToken;
  permissionRequest(): string;
}

export function randomConversationTokenFactory(): TopicConversationTokenFactory {
  return {
    turn: () => crypto.randomUUID() as TurnId,
    request: () => crypto.randomUUID() as RequestId,
    response: () => crypto.randomUUID() as ResponseId,
    responseToken: () => crypto.randomUUID() as ResponseToken,
    card: () => crypto.randomUUID() as ResponseCardId,
    action: () => crypto.randomUUID() as ActionToken,
    permission: () => crypto.randomUUID() as PermissionToken,
    permissionRequest: () => crypto.randomUUID(),
  };
}

export interface AcceptedConversationTurn {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly responseId: ResponseId;
  readonly responseToken: ResponseToken;
  readonly initialCardId: ResponseCardId;
  readonly sourceMessageId: string;
}

interface MutablePermission {
  readonly responseId: ResponseId;
  readonly token: PermissionToken;
  readonly requestId: string;
  cardMessageId: string | null;
  settled: boolean;
  resolve(value: acp.RequestPermissionResponse): void;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface AcknowledgementPort {
  add(messageId: string): Promise<string | null>;
  remove(messageId: string, reactionId: string): Promise<boolean>;
}

export interface TopicConversationSessionOptions {
  readonly presenter: LarkPresenter;
  readonly logger: LarkLogger;
  readonly route: CardRoute;
  readonly tokens?: TopicConversationTokenFactory;
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
  readonly permissionTimeoutMs: number;
  readonly permissionMode?: () => PermissionMode;
  readonly acknowledgement?: AcknowledgementPort;
  onCancelResponse(responseId: ResponseId): Promise<void> | void;
  onPermissionDisplayFailure(responseId: ResponseId): Promise<void> | void;
}

/**
 * Application service around the Topic aggregate. It is the only layer allowed
 * to translate ACP callbacks and Feishu actions into domain commands.
 */
export class TopicConversationSession {
  private readonly aggregate = new TopicConversation();
  private readonly projector = new ResponseCardProjector();
  private readonly mapper = new ConversationCardViewMapper();
  private readonly tokens: TopicConversationTokenFactory;
  private readonly cardMessageIds = new Map<ResponseCardId, string>();
  private readonly cardAnchors = new Map<ResponseCardId, string>();
  private readonly renderQueues = new Map<ResponseCardId, Promise<void>>();
  private readonly accepted = new Map<ResponseId, AcceptedConversationTurn>();
  private readonly acknowledgements = new Map<
    ResponseId,
    { messageId: string; reactionId: string }
  >();
  private readonly removedAcknowledgements = new Set<string>();
  private readonly removingAcknowledgements = new Set<string>();
  private readonly acknowledgementRetryRequested = new Set<string>();
  private currentPermission: MutablePermission | null = null;
  private patchFailureCardId: ResponseCardId | null = null;

  constructor(private readonly options: TopicConversationSessionOptions) {
    this.tokens = options.tokens ?? randomConversationTokenFactory();
  }

  get snapshot(): TopicConversationSnapshot {
    return this.aggregate.snapshot();
  }

  accept(input: {
    sourceMessageId: string;
    content: unknown;
    profile: SessionCardMeta | null;
  }): AcceptedConversationTurn {
    const prior = this.aggregate.snapshot();
    const previousCarrier = prior.pendingBatch?.carrierResponseId ?? null;
    const turn: AcceptedConversationTurn = {
      turnId: this.tokens.turn(),
      requestId: this.tokens.request(),
      responseId: this.tokens.response(),
      responseToken: this.tokens.responseToken(),
      initialCardId: this.tokens.card(),
      sourceMessageId: input.sourceMessageId,
    };
    this.aggregate.accept({
      turnId: turn.turnId,
      request: {
        id: turn.requestId,
        sourceMessageId: input.sourceMessageId,
        content: input.content,
      },
      responseId: turn.responseId,
      responseToken: turn.responseToken,
      initialCardId: turn.initialCardId,
      profile: input.profile,
    });
    this.accepted.set(turn.responseId, turn);
    this.cardAnchors.set(turn.initialCardId, input.sourceMessageId);
    if (previousCarrier !== null) void this.renderTail(previousCarrier);
    void this.renderTail(turn.responseId);
    this.expirePermissionIfDomainRevoked();
    return turn;
  }

  attachAcknowledgement(responseId: ResponseId, reactionId: string | null): void {
    if (reactionId === null) return;
    const turn = this.acceptedTurn(responseId);
    this.acknowledgements.set(responseId, { messageId: turn.sourceMessageId, reactionId });
    const hasVisibleCard = this.response(responseId).cards.some((card) =>
      this.cardMessageIds.has(card.id),
    );
    if (hasVisibleCard) this.removeAcknowledgement(responseId);
  }

  async prepare(responseId: ResponseId, profile: SessionCardMeta | null): Promise<void> {
    this.aggregate.setProfile(responseId, profile);
    this.aggregate.prepare(responseId);
    await this.renderTail(responseId);
  }

  async activate(responseId: ResponseId): Promise<ActionToken> {
    const token = this.tokens.action();
    this.aggregate.activate(responseId, token);
    const pending = this.snapshot.pendingBatch;
    if (pending?.state === "sealed" && pending.carrierResponseId !== responseId) {
      throw new Error("only the sealed batch carrier may activate");
    }
    if (pending?.state === "sealed" && pending.carrierResponseId === responseId) {
      this.aggregate.clearSealedBatch();
    }
    await this.renderTail(responseId);
    return token;
  }

  async rotate(responseId: ResponseId, reason: "size" | "tool_boundary"): Promise<void> {
    const token = this.options.showCancelButton ? this.tokens.action() : null;
    this.aggregate.rotateTail(responseId, this.tokens.card(), "content_rotation", token);
    const cards = this.response(responseId).cards;
    const previous = cards.at(-2);
    const tail = cards.at(-1);
    if (previous !== undefined) await this.renderCard(responseId, previous.id);
    if (tail !== undefined) {
      this.cardAnchors.set(tail.id, this.acceptedTurn(responseId).sourceMessageId);
      await this.renderCard(responseId, tail.id);
    }
  }

  async applyAgentUpdate(responseId: ResponseId, update: acp.SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type !== "text") return;
        await this.appendTextChunks(responseId, "text", update.content.text);
        this.aggregate.setActivity(responseId, "responding");
        break;
      case "agent_thought_chunk":
        if (!this.options.showThoughts || update.content.type !== "text") return;
        await this.appendTextChunks(responseId, "thought", update.content.text);
        this.aggregate.setActivity(responseId, "thinking");
        break;
      case "tool_call":
        if (!this.options.showTools) return;
        this.aggregate.append(responseId, {
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title ?? "Tool",
          status:
            update.status === "completed" || update.status === "failed"
              ? update.status
              : "in_progress",
        });
        this.aggregate.setActivity(responseId, "calling_tool");
        break;
      case "tool_call_update":
        if (
          !this.options.showTools ||
          (update.status !== "completed" && update.status !== "failed")
        )
          return;
        this.aggregate.append(responseId, {
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title ?? "Tool",
          status: update.status,
        });
        this.aggregate.setActivity(responseId, "calling_tool");
        break;
      default:
        return;
    }
    await this.rotateIfNeeded(responseId);
    await this.renderTail(responseId);
  }

  async requestPermission(
    responseId: ResponseId,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const auto = autoResolvePermission(params, this.options.permissionMode?.() ?? "alwaysAsk");
    if (auto !== null) return auto;
    if (this.currentPermission !== null && !this.currentPermission.settled) {
      this.expirePermission("新的权限请求已替代上一条权限请求");
    }
    const before = this.response(responseId);
    const oldTailId = before.cards.at(-1)?.id;
    if (oldTailId === undefined) throw new Error("Response has no tail Card");
    const permissionToken = this.tokens.permission();
    const requestId = this.tokens.permissionRequest();
    const continuationCardId = this.tokens.card();
    this.cardAnchors.set(continuationCardId, this.acceptedTurn(responseId).sourceMessageId);
    this.aggregate.requestPermission({
      responseId,
      permissionToken,
      requestId,
      allowedOptionIds: new Set(params.options.map((option) => option.optionId)),
      continuationCardId,
      continuationActionToken: this.tokens.action(),
    });
    const permissionResponse = new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pending: MutablePermission = {
        responseId,
        token: permissionToken,
        requestId,
        cardMessageId: null,
        settled: false,
        resolve,
      };
      if (this.options.permissionTimeoutMs > 0) {
        pending.timeout = setTimeout(
          () => this.expirePermission("用户未在规定时间内响应，权限请求已失效"),
          this.options.permissionTimeoutMs,
        );
      }
      this.currentPermission = pending;
    });
    await this.renderCard(responseId, oldTailId);

    const permissionView: PermissionCardView = {
      route: this.options.route,
      promptToken: this.response(responseId).token as unknown as PromptToken,
      permissionToken: permissionToken as unknown as WirePermissionToken,
      requestId,
      title: params.toolCall.title ?? "Permission required",
      toolKind: params.toolCall.kind ?? "other",
      toolTitle: params.toolCall.title ?? "Tool",
      options: params.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
    };
    const permissionCardId = await this.options.presenter.sendPermissionRequestCard(
      this.acceptedTurn(responseId).sourceMessageId,
      permissionView,
    );
    if (permissionCardId === null) {
      this.aggregate.beginPermissionDisplayFailure(responseId);
      this.expirePermission("权限请求无法显示，本次执行失败", "display_failed");
      await this.renderTail(responseId);
      await this.options.onPermissionDisplayFailure(responseId);
      return permissionResponse;
    }
    const pending = this.currentPermission;
    if (pending !== null && pending.token === permissionToken && !pending.settled) {
      pending.cardMessageId = permissionCardId;
    } else {
      await this.options.presenter.expirePermissionCard(permissionCardId, "权限请求已失效");
    }
    await this.renderTail(responseId);
    return permissionResponse;
  }

  cancelPendingPermissions(reason = "Response 已结束，权限请求已失效"): void {
    this.expirePermission(reason);
  }

  consumePermission(input: {
    responseToken: string;
    permissionToken: string;
    requestId: string;
    optionId: string;
  }): "accepted" | "stale" {
    const pending = this.currentPermission;
    if (
      pending === null ||
      pending.settled ||
      this.response(pending.responseId).token !== input.responseToken ||
      pending.token !== input.permissionToken ||
      pending.requestId !== input.requestId
    ) {
      return "stale";
    }
    const result = this.aggregate.resolvePermission(pending.token, input.optionId);
    if (result !== "accepted") return result;
    pending.settled = true;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.resolve({ outcome: { outcome: "selected", optionId: input.optionId } });
    this.currentPermission = null;
    const permissionCardId = pending.cardMessageId;
    if (permissionCardId !== null) {
      void this.options.presenter.expirePermissionCard(permissionCardId, "权限已处理");
    }
    void this.renderTail(pending.responseId);
    return "accepted";
  }

  consumeCancel(input: {
    responseToken: string;
    cardId: string;
    actionToken: string;
  }): "accepted" | "stale" {
    const response = this.snapshot.turns.find(
      (turn) => turn.response.token === input.responseToken,
    )?.response;
    if (response === undefined) return "stale";
    const result = this.aggregate.consumeCardCancel({
      responseId: response.id,
      cardId: input.cardId as ResponseCardId,
      token: input.actionToken as ActionToken,
    });
    if (result === "accepted") {
      this.expirePermissionIfDomainRevoked();
      void this.renderTail(response.id);
      void this.options.onCancelResponse(response.id);
    }
    return result;
  }

  async failResponse(responseId: ResponseId, text: string): Promise<void> {
    const response = this.response(responseId);
    if (response.state.kind === "terminal") return;
    const owner = this.snapshot.executionOwnerResponseId;
    if (owner === responseId) {
      this.aggregate.append(responseId, { kind: "notice", text });
      await this.finishOwner("failed");
      return;
    }
    this.aggregate.failWaiting(responseId, text);
    this.removeAcknowledgement(responseId);
    await this.renderTail(responseId);
  }

  async finishOwner(
    outcome: Exclude<TerminalOutcome, "merged">,
    commit?: (handoff: {
      readonly pendingBatch: readonly RequestMessage[];
      readonly carrierResponseId: ResponseId;
    }) => void,
  ): Promise<{
    readonly pendingBatch: readonly RequestMessage[] | null;
    readonly carrierResponseId: ResponseId | null;
  }> {
    const owner = this.snapshot.executionOwnerResponseId;
    if (owner === null) return { pendingBatch: null, carrierResponseId: null };
    const pending = this.snapshot.pendingBatch;
    if (pending?.state === "collecting") {
      const sealed = this.aggregate.sealOwnerForPendingBatch(outcome);
      this.aggregate.clearSealedBatch();
      commit?.({ pendingBatch: sealed.messages, carrierResponseId: sealed.carrierResponseId });
      this.expirePermission("Response 已结束，权限请求已失效");
      this.removeAcknowledgement(owner);
      await this.renderTail(owner);
      return { pendingBatch: sealed.messages, carrierResponseId: sealed.carrierResponseId };
    }
    this.aggregate.seal(owner, outcome);
    this.expirePermission("Response 已结束，权限请求已失效");
    this.removeAcknowledgement(owner);
    await this.renderTail(owner);
    return { pendingBatch: null, carrierResponseId: null };
  }

  clearSealedBatch(): void {
    this.aggregate.clearSealedBatch();
  }

  async interruptTopic(): Promise<void> {
    const interrupted = this.aggregate.interruptTopic();
    this.expirePermission("Session 已中断，权限请求已失效");
    await Promise.all(
      interrupted.map(async (responseId) => {
        this.removeAcknowledgement(responseId);
        await this.renderTail(responseId);
      }),
    );
  }

  async beginTopicCancel(): Promise<ResponseId | null> {
    const before = this.snapshot;
    const owner = this.aggregate.beginTopicCancel();
    this.expirePermission("Topic 已取消，权限请求已失效");
    await Promise.all(
      before.turns
        .filter((turn) => turn.response.id !== owner && turn.response.state.kind === "in_progress")
        .map(async (turn) => {
          this.removeAcknowledgement(turn.response.id);
          await this.renderTail(turn.response.id);
        }),
    );
    if (owner !== null) await this.renderTail(owner);
    return owner;
  }

  async confirmTopicCancel(): Promise<void> {
    const owner = this.snapshot.executionOwnerResponseId;
    this.aggregate.confirmTopicCancel();
    if (owner !== null) {
      this.removeAcknowledgement(owner);
      await this.renderTail(owner);
    }
  }

  private response(responseId: ResponseId) {
    const found = this.snapshot.turns.find((turn) => turn.response.id === responseId)?.response;
    if (found === undefined) throw new Error(`unknown response: ${responseId}`);
    return found;
  }

  private acceptedTurn(responseId: ResponseId): AcceptedConversationTurn {
    const turn = this.accepted.get(responseId);
    if (turn === undefined) throw new Error(`unknown accepted response: ${responseId}`);
    return turn;
  }

  private async renderTail(responseId: ResponseId): Promise<void> {
    const tail = this.response(responseId).cards.at(-1);
    if (tail === undefined) throw new Error("Response has no tail Card");
    await this.renderCard(responseId, tail.id);
  }

  private async renderCard(responseId: ResponseId, cardId: ResponseCardId): Promise<void> {
    if (
      this.patchFailureCardId !== null &&
      this.patchFailureCardId !== cardId &&
      this.snapshot.executionOwnerResponseId === responseId
    ) {
      this.patchFailureCardId = null;
      this.aggregate.append(responseId, {
        kind: "notice",
        text: "上一张 Card 更新失败，其旧 Cancel 按钮可能仍然可见，但已经失效。",
      });
    }
    const snapshot = this.snapshot;
    const projection = this.projector.project(snapshot, responseId, cardId);
    const mapped = this.mapper.toView(snapshot, projection, this.options.route);
    if (!this.options.showCancelButton && mapped.kind === "active") {
      delete (mapped as { cancelAction?: unknown }).cancelAction;
    }
    const prior = this.renderQueues.get(cardId) ?? Promise.resolve();
    const render = prior.then(async () => {
      const externalId = this.cardMessageIds.get(cardId);
      if (externalId === undefined) {
        const anchor =
          this.cardAnchors.get(cardId) ?? this.acceptedTurn(responseId).sourceMessageId;
        const send = this.options.presenter.sendConversationCard;
        if (typeof send !== "function") return;
        const sent = await send.call(this.options.presenter, anchor, mapped);
        if (sent !== null) {
          this.cardMessageIds.set(cardId, sent);
          this.removeAcknowledgement(responseId);
        }
        return;
      }
      const update = this.options.presenter.updateConversationCard;
      if (typeof update !== "function") return;
      const updated = await update.call(this.options.presenter, externalId, mapped);
      if (updated) {
        this.removeAcknowledgement(responseId);
      } else {
        this.patchFailureCardId = cardId;
        this.options.logger.warn({ responseId, cardId }, "conversation Card patch failed");
      }
    });
    this.renderQueues.set(
      cardId,
      render.catch(() => undefined),
    );
    await render;
  }

  private async appendTextChunks(
    responseId: ResponseId,
    kind: "text" | "thought",
    text: string,
  ): Promise<void> {
    const chunks = splitUtf8(text, CARD_MARKDOWN_ROTATION_BYTE_LIMIT);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined || chunk.length === 0) continue;
      this.aggregate.append(responseId, { kind, text: chunk });
      if (index < chunks.length - 1) await this.rotate(responseId, "size");
    }
  }

  private async rotateIfNeeded(responseId: ResponseId): Promise<void> {
    const tail = this.response(responseId).cards.at(-1);
    if (tail === undefined) return;
    const bytes = tail.entries.reduce((total, entry) => total + timelineEntryBytes(entry), 0);
    if (tail.entries.length < 20 && bytes <= CARD_MARKDOWN_ROTATION_BYTE_LIMIT) return;
    if (tail.entries.length === 0) return;
    await this.rotate(responseId, "size");
  }

  private removeAcknowledgement(responseId: ResponseId): void {
    const acknowledgement = this.acknowledgements.get(responseId);
    const port = this.options.acknowledgement;
    if (acknowledgement === undefined || port === undefined) return;
    const identity = `${acknowledgement.messageId}\u0000${acknowledgement.reactionId}`;
    if (this.removedAcknowledgements.has(identity)) return;
    if (this.removingAcknowledgements.has(identity)) {
      this.acknowledgementRetryRequested.add(identity);
      return;
    }
    this.removingAcknowledgements.add(identity);
    void port
      .remove(acknowledgement.messageId, acknowledgement.reactionId)
      .then((removed) => {
        if (!removed) return;
        this.removedAcknowledgements.add(identity);
        this.acknowledgements.delete(responseId);
      })
      .catch((error) =>
        this.options.logger.debug({ error, responseId }, "acknowledgement removal failed"),
      )
      .finally(() => {
        this.removingAcknowledgements.delete(identity);
        if (this.acknowledgementRetryRequested.delete(identity)) {
          this.removeAcknowledgement(responseId);
        }
      });
  }

  private expirePermissionIfDomainRevoked(): void {
    const pending = this.currentPermission;
    if (pending === null || pending.settled) return;
    if (this.snapshot.permission?.status !== "current") {
      this.expirePermission("新消息已到达，原权限请求已失效");
    }
  }

  private expirePermission(
    reason: string,
    domainStatus: "expired" | "display_failed" = "expired",
  ): void {
    const pending = this.currentPermission;
    if (pending === null || pending.settled) return;
    if (domainStatus === "expired") this.aggregate.expirePermission(pending.token);
    pending.settled = true;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.resolve({ outcome: { outcome: "cancelled" } });
    this.currentPermission = null;
    const permissionCardId = pending.cardMessageId;
    if (permissionCardId !== null) {
      void this.options.presenter.expirePermissionCard(permissionCardId, reason);
    }
  }
}

function timelineEntryBytes(entry: TimelineEntry): number {
  switch (entry.kind) {
    case "text":
    case "thought":
    case "notice":
      return utf8PartsByteLength([entry.text]);
    case "tool":
      return utf8PartsByteLength([entry.toolCallId, entry.title, entry.status]);
  }
}

function autoResolvePermission(
  params: acp.RequestPermissionRequest,
  mode: PermissionMode,
): acp.RequestPermissionResponse | null {
  const effective = isHummingPermission(params) ? "alwaysAllow" : mode;
  if (effective === "alwaysAsk") return null;
  const prefix = effective === "alwaysAllow" ? "allow_" : "reject_";
  const option = params.options.find((candidate) => candidate.kind.startsWith(prefix));
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: option.optionId } };
}

function isHummingPermission(params: acp.RequestPermissionRequest): boolean {
  const raw = params.toolCall?.rawInput;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const direct = ["command", "cmd", "commandLine", "shellCommand", "script"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string");
  const args = [record["args"], record["argv"]].find(
    (value): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string"),
  );
  const first = (direct ?? args?.[0] ?? "").trim().split(/\s+/)[0] ?? "";
  const binary = first.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return binary === "humming" || binary === "humming.cmd" || binary === "humming.ps1";
}
