import { describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const { send } = vi.hoisted(() => ({
	send: vi.fn((..._args: unknown[]) => {
		throw new Error("captured without a network request");
	}),
}));

vi.mock("../src/providers/openai-codex.ts", () => ({
	openaiCodexProvider: () => ({
		id: "openai-codex",
		name: "Mock Codex",
		auth: { apiKey: { name: "mock", resolve: async () => ({ auth: {} }) } },
		getModels: () => [],
		stream: send,
		streamSimple: send,
	}),
}));

import { builtinProviders } from "../src/providers/all.ts";

describe("built-in safe side questions", () => {
	it("uses Codex SSE with the same cache identity and leaves ordinary WebSocket requests unchanged", () => {
		const provider = builtinProviders().find((entry) => entry.id === "openai-codex");
		expect(provider?.streamSideQuestion).toBeDefined();
		const model: Model<"openai-codex-responses"> = {
			id: "test",
			name: "Test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "Question", timestamp: 1 }] });
		const options = {
			transport: "websocket" as const,
			sessionId: "same-cache-id",
			cacheRetention: "long" as const,
			reasoning: "high" as const,
		};
		expect(() => provider!.streamSimple(model, context, options)).toThrow("captured");
		expect(() => provider!.streamSideQuestion!(model, context, options)).toThrow("captured");
		expect(send.mock.calls[0]?.[2]).toBe(options);
		expect(send.mock.calls[1]?.[2]).toEqual({ ...options, transport: "sse", disableContinuation: true });
		expect(send.mock.calls[1]?.[1]).toBe(context);
		expect(options.transport).toBe("websocket");
	});

	it("opts in the known API adapters without claiming native live-query support", () => {
		const providers = builtinProviders();
		expect(providers.length).toBeGreaterThan(10);
		expect(providers.every((provider) => typeof provider.streamSideQuestion === "function")).toBe(true);
		expect(providers.every((provider) => !provider.sideQuestionUsesLiveContext)).toBe(true);
	});
});
