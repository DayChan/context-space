import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_SUFFIX,
  AGENT_TURN_OUTPUT_SCHEMA,
  agentTurnResultSchema
} from "../src/agent/contracts";

function assertStrictRequiredObjects(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictRequiredObjects);
    return;
  }
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, unknown> | undefined;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties ?? {}));
  }
  Object.values(schema).forEach(assertStrictRequiredObjects);
}

describe("Agent Structured Output contract", () => {
  it("明确列出合法 confirmation kind 及其用途", () => {
    expect(AGENT_PROMPT_SUFFIX).toContain(
      "confirmation.kind 只能是 decision、action_approval、workspace_upgrade"
    );
    expect(AGENT_PROMPT_SUFFIX).toContain("从只读升级为可写使用 workspace_upgrade");
    expect(AGENT_PROMPT_SUFFIX).toContain("禁止使用其他值");
  });

  it("marks every object property required and represents confirmation as nullable", () => {
    assertStrictRequiredObjects(AGENT_TURN_OUTPUT_SCHEMA);
    const root = AGENT_TURN_OUTPUT_SCHEMA as {
      required: string[];
      properties: { confirmation: { anyOf: Array<{ type?: string }> } };
    };
    expect(root.required).toEqual(["message", "outcome", "confirmation"]);
    expect(root.properties.confirmation.anyOf).toContainEqual({ type: "null" });
  });

  it("accepts confirmation only for needs_confirmation", () => {
    expect(agentTurnResultSchema.parse({
      message: "实现完成",
      outcome: "completed",
      confirmation: null
    })).toMatchObject({ outcome: "completed", confirmation: null });
    expect(agentTurnResultSchema.parse({
      message: "需要选择方案",
      outcome: "needs_confirmation",
      confirmation: {
        kind: "decision",
        question: "采用哪个方案？",
        options: ["方案 A", "方案 B"]
      }
    })).toMatchObject({ outcome: "needs_confirmation" });
    expect(() => agentTurnResultSchema.parse({
      message: "需要选择方案",
      outcome: "needs_confirmation",
      confirmation: null
    })).toThrow("needs_confirmation 必须包含 confirmation");
    expect(() => agentTurnResultSchema.parse({
      message: "实现完成",
      outcome: "completed",
      confirmation: {
        kind: "decision",
        question: "多余确认",
        options: ["是", "否"]
      }
    })).toThrow("非确认结果的 confirmation 必须为 null");
  });
});
