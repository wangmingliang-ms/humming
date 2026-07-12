export interface ConversationCardFeatureGate {
  readonly v2Enabled: boolean;
}

export const DISABLED_CONVERSATION_CARD_FEATURE: ConversationCardFeatureGate = Object.freeze({
  v2Enabled: false,
});
