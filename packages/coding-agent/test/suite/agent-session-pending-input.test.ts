import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../../src/core/agent-session.ts";
import type { InputQueuedEvent } from "../../src/core/extensions/types.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("pending input admission and compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function compactingHarness(slowInput?: ReturnType<typeof gate>, inputStarted?: ReturnType<typeof gate>) {
		const started = gate();
		const compactRelease = gate();
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "slow" && slowInput) {
							inputStarted?.release();
							await slowInput.promise;
						}
					});
					pi.on("session_before_compact", async (event) => {
						started.release();
						await compactRelease.promise;
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old reply", { timestamp: Date.now() - 500 }));
		harness.session.refreshContext();
		harness.setResponses([
			fauxAssistantMessage("reply one"),
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
		]);
		const compact = harness.session.compact();
		await started.promise;
		return { harness, compact, compactRelease };
	}

	it("accepts, edits, combines and cancels inputs while manual compaction is held", async () => {
		const { harness, compact, compactRelease } = await compactingHarness();
		const dispositions: PromptDisposition[] = [];
		for (const [id, text] of [
			["a", "first"],
			["b", "second"],
			["c", "cancel"],
		]) {
			await harness.session.prompt(text, {
				source: "rpc",
				messageId: id,
				preflightResult: (result) => dispositions.push(result),
			});
		}
		expect(dispositions).toEqual(["queued", "queued", "queued"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		harness.session.updateQueuedMessage("b", "edited second");
		harness.session.combineQueuedMessages(["a", "b"]);
		harness.session.removeQueuedMessage("c");
		const settled = gate();
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.release();
		});
		compactRelease.release();
		await compact;
		await settled.promise;
		expect(getUserTexts(harness).filter((text) => text !== "old")).toEqual(["first\n\nedited second"]);
		expect(harness.session.getQueueState().messages).toEqual([]);
	});

	it("keeps an older pending input first when compaction finishes during a newer input hook", async () => {
		const slowInput = gate();
		const inputStarted = gate();
		const { harness, compact, compactRelease } = await compactingHarness(slowInput, inputStarted);
		await harness.session.prompt("first", { messageId: "a", streamingBehavior: "steer" });
		const slow = harness.session.prompt("slow", { messageId: "b", streamingBehavior: "steer" });
		await inputStarted.promise;
		compactRelease.release();
		await compact;
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		const settled = gate();
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.release();
		});
		slowInput.release();
		await slow;
		await settled.promise;
		expect(getUserTexts(harness).filter((text) => text !== "old")).toEqual(["first", "slow"]);
	});

	it("preserves both accepted and still-preparing inputs when compaction is aborted", async () => {
		const slowInput = gate();
		const inputStarted = gate();
		const { harness, compact, compactRelease } = await compactingHarness(slowInput, inputStarted);
		await harness.session.prompt("first", { messageId: "a" });
		const slow = harness.session.prompt("slow", { messageId: "b" });
		await inputStarted.promise;
		const rejectedCompaction = expect(compact).rejects.toThrow("Compaction cancelled");
		harness.session.abortCompaction();
		compactRelease.release();
		await rejectedCompaction;
		slowInput.release();
		await slow;
		expect(harness.session.getQueueState().messages.map((message) => message.message)).toEqual(["first", "slow"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(getUserTexts(harness)).toEqual(["old"]);
	});

	it("serializes simultaneous idle input hooks without waiting for the first model run", async () => {
		const inputEntered = gate();
		const releaseFirstInput = gate();
		const prepareEntered = gate();
		const releasePreparation = gate();
		const inputOrder: string[] = [];
		const dispositions: Array<[string, PromptDisposition]> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputOrder.push(event.text);
						if (event.text === "first") {
							inputEntered.release();
							await releaseFirstInput.promise;
						}
					});
					pi.on("before_agent_start", async () => {
						prepareEntered.release();
						await releasePreparation.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const first = harness.session.prompt("first", {
			messageId: "a",
			streamingBehavior: "steer",
			preflightResult: (d) => dispositions.push(["a", d]),
		});
		await inputEntered.promise;
		const second = harness.session.prompt("second", {
			messageId: "b",
			streamingBehavior: "steer",
			preflightResult: (d) => dispositions.push(["b", d]),
		});
		releaseFirstInput.release();
		await prepareEntered.promise;
		await second;
		expect(inputOrder).toEqual(["first", "second"]);
		expect(dispositions).toEqual([["b", "queued"]]);
		expect(harness.session.getQueueState().messages.map((message) => message.id)).toEqual(["b"]);
		releasePreparation.release();
		await first;
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("notifies extensions only after accepted input is queued", async () => {
		const prepareEntered = gate();
		const releasePreparation = gate();
		const observed: Array<{ event: InputQueuedEvent; pending: boolean; ids: string[] }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						prepareEntered.release();
						await releasePreparation.promise;
					});
					pi.on("input", (event) => {
						if (event.text === "handled") return { action: "handled" };
						if (event.text === "modify") return { action: "transform", text: "prepared" };
					});
					pi.on("input_queued", (event, ctx) => {
						observed.push({
							event,
							pending: ctx.hasPendingMessages(),
							ids: harness.session.getQueueState().messages.map((input) => input.id),
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const run = harness.session.prompt("start");
		await prepareEntered.promise;
		expect(observed).toEqual([]);
		await harness.session.prompt("modify", { source: "rpc", messageId: "a", streamingBehavior: "steer" });
		await harness.session.prompt("handled", { source: "rpc", messageId: "handled", streamingBehavior: "steer" });
		await expect(
			harness.session.prompt("duplicate", { source: "rpc", messageId: "a", streamingBehavior: "steer" }),
		).rejects.toThrow("Queued message ID already exists");
		await harness.session.steer("second", undefined, { source: "rpc", messageId: "b" });
		await harness.session.followUp("later", undefined, { source: "extension", messageId: "c" });
		expect(
			observed.map(({ event, pending, ids }) => ({
				id: event.messageId,
				text: event.message,
				mode: event.mode,
				source: event.source,
				pending,
				ids,
			})),
		).toEqual([
			{ id: "a", text: "prepared", mode: "steer", source: "rpc", pending: true, ids: ["a"] },
			{ id: "b", text: "second", mode: "steer", source: "rpc", pending: true, ids: ["a", "b"] },
			{ id: "c", text: "later", mode: "followUp", source: "extension", pending: true, ids: ["a", "b", "c"] },
		]);
		harness.session.updateQueuedMessage("a", "edited");
		harness.session.combineQueuedMessages(["a", "b"]);
		harness.session.removeQueuedMessage("c");
		expect(observed).toHaveLength(3);
		releasePreparation.release();
		await run;
		expect(getUserTexts(harness)).toEqual(["start", "edited\n\nsecond"]);
	});

	it("preserves received order when one queued input hook is slow", async () => {
		const releasePreparation = gate();
		const prepareEntered = gate();
		const releaseFirstInput = gate();
		const firstInputEntered = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						prepareEntered.release();
						await releasePreparation.promise;
					});
					pi.on("input", async (event) => {
						if (event.text === "slow first") {
							firstInputEntered.release();
							await releaseFirstInput.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const run = harness.session.prompt("start");
		await prepareEntered.promise;
		const first = harness.session.steer("slow first", undefined, { messageId: "a" });
		await firstInputEntered.promise;
		const second = harness.session.steer("fast second", undefined, { messageId: "b" });
		releaseFirstInput.release();
		await Promise.all([first, second]);
		expect(harness.session.getQueueState().messages.map((message) => message.id)).toEqual(["a", "b"]);
		releasePreparation.release();
		await run;
		expect(getUserTexts(harness)).toEqual(["start", "slow first", "fast second"]);
	});
});
