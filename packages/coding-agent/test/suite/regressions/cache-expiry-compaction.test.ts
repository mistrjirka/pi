import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SideQuestionSnapshots } from "../../../src/core/side-questions.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("cache-expiry compaction boundaries", () => {
	const harnesses: Harness[] = [];
	const gates: ReturnType<typeof gate>[] = [];
	const held = () => {
		const result = gate();
		gates.push(result);
		return result;
	};

	afterEach(async () => {
		for (const pending of gates.splice(0)) pending.release();
		for (const harness of harnesses.splice(0)) {
			await harness.session.abort();
			harness.cleanup();
		}
	});

	async function fixture() {
		const started = held();
		const summary = held();
		const toolStarted = held();
		const tools = [held(), held()];
		const checkpointStarted = held();
		const checkpointDone = held();
		checkpointDone.release();
		let toolSignal: AbortSignal | undefined;
		let beforeCount = 0;
		let afterCount = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 1000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				cacheMaintenance: "compact",
				retry: { enabled: false },
			},
			tools: tools.map((pending, index) => ({
				name: `wait_${index}`,
				label: `wait ${index}`,
				description: "Wait for a controlled command",
				parameters: Type.Object({}),
				executionMode: "parallel" as const,
				execute: async (_id, _args, signal) => {
					toolSignal = signal;
					toolStarted.release();
					await pending.promise;
					return { content: [{ type: "text" as const, text: `saved tool result ${index}` }], details: {} };
				},
			})),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event, ctx) => {
						if (event.reason !== "cache-expiry") return;
						beforeCount++;
						expect(event.method).toBe("cache-aware");
						expect(ctx.getCompactionMethod?.()).toBe("cache-aware");
						expect(JSON.stringify(event.cacheRequest?.context)).not.toContain("saved tool result");
						started.release();
						await summary.promise;
						return {
							compaction: {
								summary: "Prepared checkpoint from the committed request prefix",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("session_compact", async (event) => {
						if (event.reason !== "cache-expiry") return;
						afterCount++;
						checkpointStarted.release();
						await checkpointDone.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.toolExecution = "parallel";
		const capture = new SideQuestionSnapshots({
			agent: harness.session.agent,
			sessionManager: harness.sessionManager,
			modelRuntime: harness.session.modelRuntime,
			getExtensionRunner: () => harness.session.extensionRunner,
			getSystemPrompt: () => harness.session.systemPrompt,
			buildOptions: (options) => options,
		});
		const stream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = async (model, context, options) => {
			capture.capture(model, context, options ?? {});
			return stream(model, context, options);
		};
		harness.sessionManager.appendMessage({
			role: "user",
			content: "Earlier important instructions ".repeat(30),
			timestamp: 1,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier completed work", { timestamp: 2 }));
		harness.session.refreshContext();
		return {
			harness,
			started,
			summary,
			toolStarted,
			tools,
			checkpointStarted,
			get toolSignal() {
				return toolSignal;
			},
			counts: () => ({ beforeCount, afterCount }),
		};
	}

	it("keeps pending parallel results, a user correction and a child notification exactly once", async () => {
		const f = await fixture();
		let nextContext = "";
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_0", {}, { id: "a" }), fauxToolCall("wait_1", {}, { id: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(f.harness.session.isCompacting).toBe(false);
				nextContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("Continued after checkpoint");
			},
		]);
		const run = f.harness.session.prompt("Run two commands");
		await f.toolStarted.promise;
		const preparation = f.harness.session.prepareCacheCompaction(new AbortController().signal);
		await f.started.promise;
		await f.harness.session.sendCustomMessage(
			{ customType: "child", content: "child finished", display: true },
			{ triggerTurn: false },
		);
		await f.harness.session.prompt("new user correction", { streamingBehavior: "steer" });
		f.tools[0].release();
		f.tools[1].release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.harness.faux.state.callCount).toBe(1);
		expect(f.harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(f.toolSignal?.aborted).toBe(false);
		f.summary.release();
		await preparation;
		await run;
		expect(f.counts()).toEqual({ beforeCount: 1, afterCount: 1 });
		expect(f.harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(nextContext).toContain("Prepared checkpoint");
		for (const text of ["saved tool result 0", "saved tool result 1", "child finished", "new user correction"]) {
			expect(nextContext.split(text)).toHaveLength(2);
		}
		const results = f.harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(
			f.harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && part.id === "a"),
			),
		).toBe(true);
	});

	it("serializes idle compaction with incoming user input and a custom wake", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("Initial completed answer")]);
		await f.harness.session.prompt("Initial request");
		const preparation = f.harness.session.prepareCacheCompaction(new AbortController().signal);
		await f.started.promise;
		const seen: string[] = [];
		f.harness.setResponses([
			(context) => {
				seen.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("Custom reply");
			},
			(context) => {
				seen.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("User reply");
			},
		]);
		const input = f.harness.session.prompt("arrived during idle compaction");
		await f.harness.session.sendCustomMessage(
			{ customType: "child", content: "idle child wake", display: true },
			{
				triggerTurn: true,
				deliverAs: "followUp",
			},
		);
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(1);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = f.harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		f.summary.release();
		await preparation;
		await input;
		await settled;
		expect(seen).toHaveLength(2);
		expect(seen[0]).toContain("Prepared checkpoint");
		expect(seen[0]).toContain("idle child wake");
		expect(seen[1]).toContain("arrived during idle compaction");
		expect(f.harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.counts()).toEqual({ beforeCount: 1, afterCount: 1 });
	});

	it.each(["abort", "auto off", "context edit"] as const)(
		"discards stale preparation after %s without aborting the command",
		async (change) => {
			const f = await fixture();
			f.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_0", {}, { id: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Command completed"),
			]);
			const run = f.harness.session.prompt("Run a command");
			await f.toolStarted.promise;
			const preparation = f.harness.session.prepareCacheCompaction(new AbortController().signal);
			await f.started.promise;
			if (change === "abort") f.harness.session.abortCompaction();
			if (change === "auto off") f.harness.session.setAutoCompactionEnabled(false);
			if (change === "context edit") {
				const old = f.harness.sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user")!;
				f.harness.sessionManager.appendContextEdit(old.id, { content: "Corrected earlier instructions" });
			}
			f.summary.release();
			await preparation;
			expect(f.toolSignal?.aborted).toBe(false);
			f.tools[0].release();
			await run;
			expect(f.harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(f.harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: "cache-expiry",
				aborted: true,
			});
			expect(f.harness.session.messages.some((message) => getMessageText(message) === "saved tool result 0")).toBe(
				true,
			);
		},
	);

	it("does not prepare during model generation, input activity, or explicit auto-off", async () => {
		const f = await fixture();
		const modelStarted = held();
		const modelDone = held();
		f.harness.setResponses([
			async () => {
				modelStarted.release();
				await modelDone.promise;
				return fauxAssistantMessage("Completed answer");
			},
		]);
		const run = f.harness.session.prompt("A model request");
		await modelStarted.promise;
		expect(await f.harness.session.prepareCacheCompaction(new AbortController().signal)).toBe(false);
		modelDone.release();
		await run;
		f.harness.session.setInputActive(true);
		expect(await f.harness.session.prepareCacheCompaction(new AbortController().signal)).toBe(false);
		f.harness.session.setInputActive(false);
		f.harness.session.setAutoCompactionEnabled(false);
		expect(await f.harness.session.prepareCacheCompaction(new AbortController().signal)).toBe(false);
		expect(f.counts()).toEqual({ beforeCount: 0, afterCount: 0 });
	});
});
