import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test-codex",
	name: "Test Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
const context: Context = {
	systemPrompt: "Test",
	messages: [{ role: "user", content: "First request", timestamp: 1 }],
};
const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString(
	"base64",
);
const options = {
	apiKey: `test.${payload}.test`,
	sessionId: "abort-test",
	transport: "websocket-cached" as const,
};

function completed(id: string) {
	return {
		type: "response.completed",
		response: {
			id,
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		},
	};
}

const textEvents = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Before steering" },
];
const lateToolEvents = [
	{
		type: "response.output_item.added",
		item: { type: "function_call", id: "fc_late", call_id: "call_late", name: "write", arguments: "" },
	},
	{
		type: "response.output_item.done",
		item: { type: "function_call", id: "fc_late", call_id: "call_late", name: "write", arguments: "{}" },
	},
];

class MockWebSocket extends EventTarget {
	static instances: MockWebSocket[] = [];
	static requests: Array<Record<string, unknown>> = [];
	static respond: (socket: MockWebSocket, requestIndex: number) => void = (socket, requestIndex) =>
		socket.emit(completed(`resp_${requestIndex}`));
	readyState = 1;

	constructor() {
		super();
		MockWebSocket.instances.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}

	send(data: string): void {
		MockWebSocket.requests.push(JSON.parse(data) as Record<string, unknown>);
		const requestIndex = MockWebSocket.requests.length;
		queueMicrotask(() => MockWebSocket.respond(this, requestIndex));
	}

	emit(...events: unknown[]): void {
		for (const event of events) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
	}

	close(): void {
		this.readyState = 3;
	}
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	MockWebSocket.instances = [];
	MockWebSocket.requests = [];
	MockWebSocket.respond = (socket, requestIndex) => socket.emit(completed(`resp_${requestIndex}`));
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Codex request cancellation", () => {
	it("does not submit a pre-aborted request on a cached connection", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const first = await stream(model, normalizeContext(context), { ...options, fetch }).result();
		expect(first.stopReason).toBe("stop");
		const controller = new AbortController();
		controller.abort();

		const result = await stream(
			model,
			normalizeContext({
				...context,
				messages: [...context.messages, first, { role: "user", content: "Cancelled", timestamp: 2 }],
			}),
			{ ...options, fetch, signal: controller.signal },
		).result();

		expect(result.stopReason).toBe("aborted");
		expect(MockWebSocket.requests).toHaveLength(1);
		expect(MockWebSocket.instances[0].readyState).toBe(3);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("drops an aborted socket and its continuation before the replacement request", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const first = await stream(model, normalizeContext(context), { ...options, fetch }).result();
		MockWebSocket.respond = (socket, requestIndex) => {
			if (requestIndex === 2)
				socket.emit({ type: "response.created", response: { id: "resp_aborted" } }, ...textEvents);
			else socket.emit(completed(`resp_${requestIndex}`));
		};
		const controller = new AbortController();
		const followUp = normalizeContext({
			...context,
			messages: [...context.messages, first, { role: "user", content: "Second request", timestamp: 2 }],
		});
		const active = stream(model, followUp, { ...options, fetch, signal: controller.signal });
		for await (const event of active) {
			if (event.type === "text_delta") controller.abort();
		}
		expect((await active.result()).stopReason).toBe("aborted");
		expect(MockWebSocket.requests[1].previous_response_id).toBe("resp_1");
		expect(MockWebSocket.instances[0].readyState).toBe(3);
		MockWebSocket.instances[0].emit(...lateToolEvents, completed("resp_aborted"));

		const replacement = await stream(model, followUp, { ...options, fetch }).result();

		expect(replacement.stopReason).toBe("stop");
		expect(replacement.content).toEqual([]);
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(MockWebSocket.requests).toHaveLength(3);
		expect(MockWebSocket.requests[2].previous_response_id).toBeUndefined();
		expect(MockWebSocket.requests[2].input).toEqual([
			{ role: "system", content: "Test" },
			{ role: "user", content: [{ type: "input_text", text: "First request" }] },
			{ role: "user", content: [{ type: "input_text", text: "Second request" }] },
		]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("stops parsing buffered SSE events after steering aborts the request", async () => {
		const controller = new AbortController();
		const events = [...textEvents, ...lateToolEvents, completed("resp_sse")];
		const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
		const active = stream(model, normalizeContext(context), {
			...options,
			transport: "sse",
			fetch,
			signal: controller.signal,
			onProviderStreamEvent: (event) => {
				if (event && typeof event === "object" && "type" in event && event.type === "response.output_text.delta") {
					controller.abort();
				}
			},
		});
		const observed: string[] = [];
		for await (const event of active) {
			observed.push(event.type);
		}

		expect((await active.result()).stopReason).toBe("aborted");
		expect(observed).toContain("text_delta");
		expect(observed).not.toContain("toolcall_start");
		expect(observed).not.toContain("toolcall_end");
		expect(observed).not.toContain("done");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
