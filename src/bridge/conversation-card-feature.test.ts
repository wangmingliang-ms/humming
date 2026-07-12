import { describe, expect, it } from "vitest";
import {
  DISABLED_CONVERSATION_CARD_FEATURE,
  type ConversationCardFeatureGate,
} from "./conversation-card-feature.js";

describe("conversation card feature gate", () => {
  it("exports one immutable disabled production default", () => {
    expect(DISABLED_CONVERSATION_CARD_FEATURE).toEqual({ v2Enabled: false });
    expect(Object.isFrozen(DISABLED_CONVERSATION_CARD_FEATURE)).toBe(true);
    expect(() => {
      (DISABLED_CONVERSATION_CARD_FEATURE as { v2Enabled: boolean }).v2Enabled = true;
    }).toThrow();
  });

  it("allows an explicit isolated enabled fixture without changing the default", () => {
    const enabled: ConversationCardFeatureGate = Object.freeze({ v2Enabled: true });

    expect(enabled.v2Enabled).toBe(true);
    expect(DISABLED_CONVERSATION_CARD_FEATURE.v2Enabled).toBe(false);
  });
});
