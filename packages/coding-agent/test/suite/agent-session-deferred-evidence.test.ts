import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("deferred nested evidence", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("persists a delayed write and its usage exactly once after the original agent run ends", async () => {
		const started = gate();
		const release = gate();
		let writes = 0;
		let completion: Promise<AgentToolResult> | undefined;
		let collected = false;
		let directory = "";
		const parameters = Type.Object({ path: Type.String() });
		const write: AgentTool<typeof parameters> = {
			name: "write",
			label: "Write",
			description: "Test write",
			parameters,
			async execute(_id, args) {
				writes++;
				started.release();
				await release.promise;
				await writeFile(join(directory, args.path), "committed", "utf8");
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
						description: "Deferred test cell",
						parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("collect")]) }),
						async execute(_id, params, _signal, _update, ctx) {
							if (params.action === "start") {
								const takeEvidence = ctx.takeNestedToolCalls?.bind(ctx);
								completion = ctx.executeTool("write", { path: "changed.txt" }).then((outcome) => {
									const summary = takeEvidence?.();
									return {
										content: outcome.result.content,
										details: {},
										nestedCalls: summary?.calls,
										usage: summary?.usage,
									};
								});
								await started.promise;
								return { content: [{ type: "text", text: "running cell" }], details: {} };
							}
							if (!completion) throw new Error("No execution to collect");
							const result = await completion;
							if (collected) return { content: result.content, details: {} };
							collected = true;
							return result;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		directory = harness.tempDir;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cell", { action: "start" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("You can continue while the write runs."),
		]);
		try {
			await harness.session.prompt("start");
			expect(harness.eventsOfType("agent_end")).toHaveLength(1);
			const original = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "cell",
			);
			expect(original?.role).toBe("toolResult");
			if (original?.role !== "toolResult") throw new Error("Missing initial cell result");
			expect(original.nestedCalls?.calls[0]).toMatchObject({
				name: "write",
				status: "unfinished",
				arguments: { path: "changed.txt" },
			});
			expect(original.usage).toBeUndefined();
			release.release();
			await completion;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("cell", { action: "collect" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Collected."),
			]);
			await harness.session.prompt("collect");
			const results = harness.session.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "cell",
			);
			expect(results).toHaveLength(2);
			expect(results[1]?.nestedCalls?.calls).toEqual([
				expect.objectContaining({
					id: original.nestedCalls?.calls[0]?.id,
					name: "write",
					status: "ok",
					arguments: { path: "changed.txt" },
				}),
			]);
			expect(results[1]?.usage?.totalTokens).toBe(20);
			expect(results[1]?.usage?.cost.total).toBeCloseTo(0.012);
			expect(original.nestedCalls?.calls[0]?.status).toBe("unfinished");
			expect(writes).toBe(1);
			expect(await readFile(join(directory, "changed.txt"), "utf8")).toBe("committed");
			const persisted = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "cell"
						? [entry.message]
						: [],
				);
			expect(persisted[1]?.nestedCalls).toEqual(results[1]?.nestedCalls);
			expect(persisted[1]?.usage?.totalTokens).toBe(20);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("cell", { action: "collect" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Already collected."),
			]);
			await harness.session.prompt("collect again");
			const repeated = harness.session.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "cell",
			);
			expect(repeated[2]?.nestedCalls).toBeUndefined();
			expect(repeated[2]?.usage).toBeUndefined();
			expect(writes).toBe(1);
		} finally {
			release.release();
			await completion;
		}
	});
});
