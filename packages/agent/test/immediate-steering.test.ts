import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "../src/index.ts";

const model: Model<"openai-responses"> = {
	id: "test",
	name: "Test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function answer(content: AssistantMessage["content"] = [{ type: "text", text: "done" }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test",
		model: "test",
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function completed(message = answer()) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	return stream;
}

describe("immediate user steering", () => {
	it("replaces a held response in one run and ignores late or partial tool calls", async () => {
		const started = deferred();
		const oldStream = createAssistantMessageEventStream();
		const partial = answer([
			{ type: "text", text: "old draft" },
			{ type: "toolCall", id: "incomplete", name: "write", arguments: { path: "wrong" } },
		]);
		let calls = 0;
		let toolRuns = 0;
		let firstSignal: AbortSignal | undefined;
		const events: AgentEvent[] = [];
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "",
			parameters: obj({}),
			execute: async () => {
				toolRuns++;
				return { content: [], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: (_model, _context, options) => {
				calls++;
				if (calls > 1) return completed();
				firstSignal = options?.signal;
				oldStream.push({ type: "start", partial });
				return oldStream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_start" && event.message.role === "assistant") started.resolve();
		});
		const running = agent.prompt("original");
		await started.promise;
		const runSignal = agent.signal;
		agent.steer(user("correction"));
		await running;

		expect(calls).toBe(2);
		expect(firstSignal?.aborted).toBe(true);
		expect(runSignal?.aborted).toBe(false);
		expect(toolRuns).toBe(0);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(
			agent.state.messages.filter((message) => message.role === "user" && message.content === "correction"),
		).toHaveLength(1);
		const interrupted = agent.state.messages.find((message) => message.role === "assistant");
		expect(interrupted?.content).toEqual([{ type: "text", text: "old draft" }]);
		expect(interrupted?.role === "assistant" && interrupted.stopReason).toBe("aborted");
		const beforeLateEvents = events.length;
		partial.content.push({ type: "text", text: "late mutation" });
		oldStream.push({ type: "done", reason: "toolUse", message: partial });
		await Promise.resolve();
		expect(events).toHaveLength(beforeLateEvents);
		expect(interrupted?.content).toEqual([{ type: "text", text: "old draft" }]);
	});

	it("does not interrupt for background notifications or explicit follow-ups", async () => {
		const started = deferred();
		const stream = createAssistantMessageEventStream();
		let firstSignal: AbortSignal | undefined;
		let calls = 0;
		let notifications = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: (_model, _context, options) => {
				calls++;
				if (calls > 1) return completed();
				firstSignal = options?.signal;
				started.resolve();
				return stream;
			},
		});
		const unsubscribe = agent.onUserSteering(() => notifications++);
		const running = agent.prompt("original");
		await started.promise;
		agent.steer({ role: "system", content: "background result", timestamp: Date.now() });
		agent.followUp(user("later"));
		await Promise.resolve();
		expect(firstSignal?.aborted).toBe(false);
		expect(agent.hasPendingUserSteering()).toBe(false);
		expect(notifications).toBe(0);
		expect(calls).toBe(1);
		stream.push({ type: "done", reason: "stop", message: answer() });
		await running;
		unsubscribe();
		expect(calls).toBe(3);
	});

	it("finishes an already-running effect once and skips later sequential calls", async () => {
		const started = deferred();
		const release = deferred();
		let firstRuns = 0;
		let laterRuns = 0;
		let toolSignal: AbortSignal | undefined;
		let requests = 0;
		const tools: AgentTool[] = [
			{
				name: "first",
				label: "First",
				description: "",
				parameters: obj({}),
				execute: async (_id, _args, signal) => {
					firstRuns++;
					toolSignal = signal;
					started.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "effect committed" }], details: {} };
				},
			},
			{
				name: "later",
				label: "Later",
				description: "",
				parameters: obj({}),
				execute: async () => {
					laterRuns++;
					return { content: [], details: {} };
				},
			},
		];
		const agent = new Agent({
			initialState: { model, tools },
			toolExecution: "sequential",
			streamFn: () =>
				completed(
					++requests === 1
						? answer([
								{ type: "toolCall", id: "first-id", name: "first", arguments: {} },
								{ type: "toolCall", id: "later-id", name: "later", arguments: {} },
							])
						: answer(),
				),
		});
		const running = agent.prompt("original");
		await started.promise;
		agent.steer(user("stop the remaining edits"));
		expect(toolSignal?.aborted).toBe(false);
		release.resolve();
		await running;
		expect(firstRuns).toBe(1);
		expect(laterRuns).toBe(0);
		expect(requests).toBe(2);
		const results = agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.toolCallId)).toEqual(["first-id", "later-id"]);
		expect(results[0]?.isError).toBe(false);
		expect(results[1]?.isError).toBe(true);
		expect(results[1]?.content).toEqual([{ type: "text", text: expect.stringContaining("Not executed") }]);
	});

	it("does not launch parallel effects after input arrives during preflight", async () => {
		const preparing = deferred();
		const release = deferred();
		let effectRuns = 0;
		let requests = 0;
		const tool: AgentTool = {
			name: "effect",
			label: "Effect",
			description: "",
			parameters: obj({}),
			execute: async () => {
				effectRuns++;
				return { content: [], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			toolExecution: "parallel",
			beforeToolCall: async ({ toolCall }) => {
				if (toolCall.id === "second") {
					preparing.resolve();
					await release.promise;
				}
			},
			streamFn: () =>
				completed(
					++requests === 1
						? answer([
								{ type: "toolCall", id: "first", name: "effect", arguments: {} },
								{ type: "toolCall", id: "second", name: "effect", arguments: {} },
							])
						: answer(),
				),
		});
		const running = agent.prompt("original");
		await preparing.promise;
		agent.steer(user("changed"));
		release.resolve();
		await running;
		expect(effectRuns).toBe(0);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	});

	it("keeps asynchronous request preparation exclusive and then processes input before submission", async () => {
		const preparing = deferred();
		const release = deferred();
		let preparations = 0;
		const submitted: string[][] = [];
		const agent = new Agent({
			initialState: { model },
			prepareRequest: async () => {
				if (++preparations === 1) {
					preparing.resolve();
					await release.promise;
				}
			},
			streamFn: (_model, context) => {
				submitted.push(
					context.messages.flatMap((message) =>
						message.role !== "user"
							? []
							: typeof message.content === "string"
								? [message.content]
								: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
					),
				);
				return completed();
			},
		});
		const running = agent.prompt("original");
		await preparing.promise;
		agent.steer(user("changed during preparation"));
		await Promise.resolve();
		expect(submitted).toEqual([]);
		release.resolve();
		await running;
		expect(submitted).toEqual([["original", "changed during preparation"]]);
	});

	it("delivers repeated corrections exactly once and retains queue order", async () => {
		const started = deferred();
		let calls = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: () => {
				if (++calls > 1) return completed();
				started.resolve();
				return createAssistantMessageEventStream();
			},
		});
		const running = agent.prompt("original");
		await started.promise;
		agent.steer(user("first correction"));
		agent.steer(user("second correction"));
		await running;
		expect(calls).toBe(3);
		expect(agent.state.messages.flatMap((message) => (message.role === "user" ? [message.content] : []))).toEqual([
			[{ type: "text", text: "original" }],
			"first correction",
			"second correction",
		]);
		expect(agent.hasPendingUserSteering()).toBe(false);
	});

	it("keeps explicit cancellation separate from steering", async () => {
		const started = deferred();
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			started.resolve();
			return createAssistantMessageEventStream();
		};
		const agent = new Agent({ initialState: { model }, streamFn });
		const running = agent.prompt("original");
		await started.promise;
		agent.steer(user("queued"));
		agent.abort();
		await running;
		expect(calls).toBe(1);
		expect(agent.hasPendingUserSteering()).toBe(true);
		expect(agent.state.messages.at(-1)?.role).toBe("assistant");
		expect(agent.state.isStreaming).toBe(false);
	});
	it("retains a selected steer when another arrives during next-turn compaction", async () => {
		const preparing = deferred();
		const release = deferred();
		let preparations = 0;
		let requests = 0;
		let compactionSignal: AbortSignal | undefined;
		const tool: AgentTool = {
			name: "step",
			label: "Step",
			description: "",
			parameters: obj({}),
			execute: async () => {
				agent.steer(user("first correction"));
				return { content: [], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			prepareNextTurn: async (signal) => {
				if (++preparations === 1) {
					compactionSignal = signal;
					preparing.resolve();
					await release.promise;
				}
			},
			streamFn: () =>
				completed(
					++requests === 1 ? answer([{ type: "toolCall", id: "step-id", name: "step", arguments: {} }]) : answer(),
				),
		});
		const running = agent.prompt("original");
		await preparing.promise;
		agent.steer(user("second correction"));
		expect(compactionSignal?.aborted).toBe(false);
		expect(requests).toBe(1);
		release.resolve();
		await running;
		expect(requests).toBe(2);
		expect(
			agent.state.messages.flatMap((message) =>
				message.role === "user" && typeof message.content === "string" ? [message.content] : [],
			),
		).toEqual(["first correction", "second correction"]);
	});

	it("delivers input from a completed-message listener without reclassifying that response", async () => {
		let requests = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: () => {
				requests++;
				return completed();
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && requests === 1) {
				agent.steer(user("correction"));
			}
		});
		await agent.prompt("original");
		expect(requests).toBe(2);
		expect(
			agent.state.messages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
		).toEqual(["stop", "stop"]);
		expect(
			agent.state.messages.filter((message) => message.role === "user" && message.content === "correction"),
		).toHaveLength(1);
	});

	it("abandons stale asynchronous authentication without ever submitting its request", async () => {
		const resolving = deferred();
		const release = deferred();
		let resolutions = 0;
		let requests = 0;
		const agent = new Agent({
			initialState: { model },
			getApiKey: async () => {
				if (++resolutions === 1) {
					resolving.resolve();
					await release.promise;
				}
				return "test-key";
			},
			streamFn: () => {
				requests++;
				return completed();
			},
		});
		const running = agent.prompt("original");
		await resolving.promise;
		agent.steer(user("correction"));
		await running;
		expect(requests).toBe(1);
		release.resolve();
		await Promise.resolve();
		expect(requests).toBe(1);
	});
	it("retains input accepted synchronously by a queue-removal listener", async () => {
		const first = user("first correction");
		const second = user("second correction");
		let requests = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: () => {
				requests++;
				return completed();
			},
		});
		agent.subscribeQueueRemoval((messages) => {
			if (messages.includes(first)) agent.steer(second);
		});
		agent.steer(first);
		await agent.prompt("original");
		expect(requests).toBe(1);
		expect(agent.state.messages.filter((message) => message.role === "user").slice(1)).toEqual([first, second]);
	});
});
