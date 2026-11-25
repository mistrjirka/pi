import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { createHarness, getAssistantTexts, getToolResult, type Harness } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("tool completion settlement", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("streams corrections while a detached write runs, then publishes its outcome once before settlement", async () => {
		const started = gate();
		const release = gate();
		const firstBoundary = gate();
		const secondBoundary = gate();
		let boundaries = 0;
		let writes = 0;
		let directory = "";
		let completion: Promise<AgentToolResult<unknown>> | undefined;
		let publish: ((result: AgentToolResult<unknown>) => void) | undefined;
		let published: AgentToolResult<unknown> | undefined;
		let settled = false;
		const parameters = Type.Object({ path: Type.String() });
		const write: AgentTool<typeof parameters> = {
			name: "write",
			label: "Write",
			description: "Held write",
			parameters,
			async execute(_id, args) {
				writes++;
				started.release();
				await release.promise;
				await writeFile(join(directory, args.path), "committed");
				return {
					content: [{ type: "text", text: "written" }],
					details: {},
					usage: {
						input: 17,
						output: 3,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0.01, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.012 },
					},
				};
			},
		};
		const harness = await createHarness({
			tools: [write],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "cell",
						label: "Cell",
						description: "Held cell",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							publish = ctx.publishToolCompletion?.bind(ctx);
							const takeEvidence = ctx.takeNestedToolCalls?.bind(ctx);
							completion = ctx.executeTool("write", { path: "changed.txt" }).then((outcome) => {
								const summary = takeEvidence?.();
								return {
									content: outcome.result.content,
									details: { state: "checkpoint", status: "suspended" },
									nestedCalls: summary?.calls,
									usage: summary?.usage,
								};
							});
							await started.promise;
							return { content: [{ type: "text", text: "running" }], details: { state: "before" } };
						},
					});
					pi.on("agent_before_settle", async (_event, ctx) => {
						if (!completion || published) return;
						boundaries++;
						(boundaries === 1 ? firstBoundary : secondBoundary).release();
						let interrupt = () => {};
						const interrupted = new Promise<undefined>((resolve) => {
							interrupt = () => resolve(undefined);
						});
						const unsubscribe = ctx.onUserSteering?.(interrupt);
						const signal = ctx.signal;
						signal?.addEventListener("abort", interrupt, { once: true });
						try {
							if (ctx.hasPendingUserSteering?.() || signal?.aborted) interrupt();
							const result = await Promise.race([completion, interrupted]);
							if (!result || signal?.aborted) return;
							if (!publish) throw new Error("Missing publication API");
							publish(result);
							published = result;
						} finally {
							unsubscribe?.();
							signal?.removeEventListener("abort", interrupt);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const observerError = vi.spyOn(console, "error").mockImplementation(() => {});
		let observedCompletions = 0;
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "tool_completion")
				throw new Error("broken observer");
		});
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "tool_completion") observedCompletions++;
		});
		directory = harness.tempDir;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cell", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("First correction acknowledged."),
			fauxAssistantMessage("Second correction acknowledged."),
		]);
		const run = harness.session.prompt("start").then(() => {
			settled = true;
		});
		try {
			await firstBoundary.promise;
			expect(getAssistantTexts(harness)).toContain("First correction acknowledged.");
			expect(settled).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			await harness.session.prompt("correct again", { streamingBehavior: "steer", source: "rpc" });
			await secondBoundary.promise;
			expect(getAssistantTexts(harness)).toContain("Second correction acknowledged.");
			expect(settled).toBe(false);
			expect(getToolResult(harness, "cell").nestedCalls?.calls[0]?.status).toBe("unfinished");
			release.release();
			await run;
			expect(writes).toBe(1);
			expect(await readFile(join(directory, "changed.txt"), "utf8")).toBe("committed");
			const entries = harness
				.eventsOfType("entry_appended")
				.filter((event) => event.entry.type === "tool_completion");
			expect(entries).toHaveLength(1);
			expect(observedCompletions).toBe(1);
			expect(observerError).toHaveBeenCalledOnce();
			const completionIndex = harness.events.indexOf(entries[0]!);
			expect(harness.events.findIndex((event) => event.type === "agent_settled")).toBeGreaterThan(completionIndex);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			expect(getToolResult(harness, "cell").nestedCalls?.calls[0]).toMatchObject({
				name: "write",
				status: "ok",
				arguments: { path: "changed.txt" },
			});
			expect(getToolResult(harness, "cell").usage?.totalTokens).toBe(20);
			expect(
				getUsageCostBreakdown(harness.sessionManager.getEntries()).find((item) => item.key === "Tools/summaries"),
			).toMatchObject({ tokens: 20, cost: 0.012 });
			expect(harness.getPendingResponseCount()).toBe(0);
			if (!publish || !published) throw new Error("Missing completed publication");
			publish(published);
			expect(
				harness.eventsOfType("entry_appended").filter((event) => event.entry.type === "tool_completion"),
			).toHaveLength(1);
		} finally {
			release.release();
			await completion;
			await run;
		}
	});

	it("exposes an abort signal during the safe-settlement wait", async () => {
		const entered = gate();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async (_event, ctx) => {
						signal = ctx.signal;
						entered.release();
						if (!signal) throw new Error("Missing boundary signal");
						if (!signal.aborted)
							await new Promise<void>((resolve) =>
								signal?.addEventListener("abort", () => resolve(), { once: true }),
							);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Acknowledged.")]);
		const run = harness.session.prompt("start");
		await entered.promise;
		await harness.session.abort();
		await run;
		expect(signal?.aborted).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
	});

	it("rejects a captured publisher after branch navigation or session replacement", async () => {
		let publish: ((result: AgentToolResult<unknown>) => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "cell",
						label: "Cell",
						description: "Capture owner",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							publish = ctx.publishToolCompletion?.bind(ctx);
							return { content: [{ type: "text", text: "running" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cell", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Acknowledged."),
		]);
		await harness.session.prompt("start");
		if (!publish) throw new Error("Missing publication API");
		const failedResult = { content: [{ type: "text" as const, text: "finished" }], details: {} };
		const persist = vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk unavailable");
		});
		expect(() => publish?.(failedResult)).toThrow("disk unavailable");
		expect(getToolResult(harness, "cell").content).toEqual([{ type: "text", text: "running" }]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "tool_completion")).toHaveLength(0);
		persist.mockRestore();
		const first = harness.sessionManager.getBranch()[0];
		if (!first) throw new Error("Missing branch");
		harness.sessionManager.branch(first.id);
		const result = { content: [{ type: "text" as const, text: "finished" }], details: {} };
		expect(() => publish?.(result)).toThrow("different session or branch");
		harness.sessionManager.newSession();
		expect(() => publish?.(result)).toThrow("different session or branch");
		expect(
			harness.eventsOfType("entry_appended").filter((event) => event.entry.type === "tool_completion"),
		).toHaveLength(0);
	});

	it("distinguishes queued user follow-ups from custom background notifications", async () => {
		let context: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Ready.")]);
		await harness.session.prompt("start");
		if (!context) throw new Error("Missing context");
		harness.session.agent.steer({
			role: "custom",
			customType: "background",
			content: "notice",
			display: false,
			timestamp: Date.now(),
		});
		expect(context.hasPendingUserInput?.()).toBe(false);
		harness.session.agent.followUp({ role: "user", content: "user follow-up", timestamp: Date.now() });
		expect(context.hasPendingUserInput?.()).toBe(true);
		expect(context.hasPendingUserSteering?.()).toBe(false);
		harness.session.agent.clearAllQueues();
	});
});
