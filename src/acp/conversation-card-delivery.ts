import type { UnifiedCardState } from "../presenter/presenter.js";

export interface CardDeliveryTransport {
  send(state: UnifiedCardState): Promise<string | null>;
  patch(cardId: string, state: UnifiedCardState): Promise<boolean>;
}

export type CardDeliveryResult =
  { outcome: "visible"; cardId: string } | { outcome: "pending" } | { outcome: "skipped" };

export class ConversationCardDelivery {
  private activeCardId: string | null = null;
  private desiredState: UnifiedCardState | null = null;

  constructor(private readonly transport: CardDeliveryTransport) {}

  async deliver(state: UnifiedCardState): Promise<CardDeliveryResult> {
    this.desiredState = state;
    if (this.activeCardId === null) return this.createCard(state);

    const cardId = this.activeCardId;
    if (await this.patchActiveCard(cardId, state)) {
      return { outcome: "visible", cardId };
    }

    this.abandon(cardId);
    return this.createCard(state);
  }

  adopt(cardId: string): void {
    this.activeCardId = cardId;
  }

  detach(): void {
    this.activeCardId = null;
  }

  reset(): void {
    this.activeCardId = null;
    this.desiredState = null;
  }

  hasCard(): boolean {
    return this.activeCardId !== null;
  }

  takeActiveCardId(): string | null {
    const cardId = this.activeCardId;
    this.activeCardId = null;
    return cardId;
  }

  private async createCard(state: UnifiedCardState): Promise<CardDeliveryResult> {
    const cardId = await this.transport.send(state);
    if (cardId === null) return { outcome: "pending" };

    this.activeCardId = cardId;
    return { outcome: "visible", cardId };
  }

  private async patchActiveCard(cardId: string, state: UnifiedCardState): Promise<boolean> {
    try {
      return await this.transport.patch(cardId, state);
    } catch {
      return false;
    }
  }

  private abandon(cardId: string): void {
    if (this.activeCardId === cardId) this.activeCardId = null;
  }
}
