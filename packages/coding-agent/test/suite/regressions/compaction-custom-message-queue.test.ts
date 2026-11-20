import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function notification(content: string) {
	return { customType: "subagent-notification", content, display: true };
}

function deliveredInputs(harness: Harness): string[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type === "custom_message") return [getMessageText(entry)];
		if (entry.type === "message" && entry.message.role === "user") return [getMessageText(entry.message)];
		return [];
	});
}

function nextSettlement(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			resolve();
		});
	});
}

describe("custom message delivery across compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createHeldCompaction(options: { automatic?: boolean; defaultSummary?: boolean } = {}) {
		const started = gate();
		const releaseSummary = gate();
		const checkpoint = gate();
		const releaseCheckpoint = gate();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 100 }],
			settings: {
				compaction: { enabled: options.automatic ?? false, keepRecentTokens: 1, reserveTokens: 10_000 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						started.release();
						await releaseSummary.promise;
						if (options.defaultSummary) return;
						return {
							compaction: {
								summary: "checkpoint for resumed work",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("session_compact", async () => {
						checkpoint.release();
						await releaseCheckpoint.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old input", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old reply", { timestamp: Date.now() - 500 }));
		harness.session.refreshContext();
		return { harness, started, releaseSummary, checkpoint, releaseCheckpoint };
	}

	it.each(["steer", "followUp"] as const)(
		"defers a custom-only %s wake until the checkpoint and completion hooks finish",
		async (deliverAs) => {
			const held = await createHeldCompaction();
			const { harness, started, releaseSummary, checkpoint, releaseCheckpoint } = held;
			const settled = nextSettlement(harness);
			const requests: Array<{ compacting: boolean; completions: number; messages: string[] }> = [];
			harness.setResponses([
				(context) => {
					requests.push({
						compacting: harness.session.isCompacting,
						completions: harness.eventsOfType("compaction_end").length,
						messages: context.messages.map(getMessageText),
					});
					return fauxAssistantMessage("continued once");
				},
			]);
			const compact = harness.session.compact();
			await started.promise;
			try {
				await harness.session.sendCustomMessage(notification("child finished"), { triggerTurn: true, deliverAs });
				expect(harness.eventsOfType("agent_start")).toHaveLength(0);
				expect(harness.faux.state.callCount).toBe(0);
				expect(deliveredInputs(harness)).toEqual(["old input"]);

				releaseSummary.release();
				await checkpoint.promise;
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
				expect(harness.session.isCompacting).toBe(true);
				expect(harness.eventsOfType("agent_start")).toHaveLength(0);
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				releaseSummary.release();
				releaseCheckpoint.release();
				await compact;
			}
			await settled;
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ compacting: false, completions: 1 });
			expect(requests[0].messages.join("\n")).toContain("checkpoint for resumed work");
			expect(requests[0].messages.filter((message) => message === "child finished")).toHaveLength(1);
			expect(deliveredInputs(harness)).toEqual(["old input", "child finished"]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("preserves delivery priority, FIFO, edits and removals with a completion-time notification", async () => {
		const { harness, started, releaseSummary, releaseCheckpoint } = await createHeldCompaction();
		harness.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("received")));
		const settled = nextSettlement(harness);
		const compact = harness.session.compact();
		await started.promise;
		try {
			await harness.session.sendCustomMessage(notification("first follow-up"), {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			await harness.session.prompt("edit me", { messageId: "edit", streamingBehavior: "followUp" });
			await harness.session.prompt("remove me", { messageId: "remove", streamingBehavior: "followUp" });
			await harness.session.sendCustomMessage(notification("urgent steer"), {
				triggerTurn: true,
				deliverAs: "steer",
			});
			await harness.session.sendCustomMessage(notification("last follow-up"), {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			harness.session.updateQueuedMessage("edit", "edited input");
			harness.session.removeQueuedMessage("remove");
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end" && event.result) {
					void harness.session.sendCustomMessage(notification("completion notice"), {
						triggerTurn: true,
						deliverAs: "followUp",
					});
				}
			});
			expect(harness.session.getQueueState().messages.map((message) => message.id)).toEqual(["edit"]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		} finally {
			releaseSummary.release();
			releaseCheckpoint.release();
			await compact;
		}
		await settled;
		expect(deliveredInputs(harness)).toEqual([
			"old input",
			"urgent steer",
			"first follow-up",
			"edited input",
			"last follow-up",
			"completion notice",
		]);
		expect(harness.faux.state.callCount).toBe(5);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.session.getQueueState().messages).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps an older user follow-up ahead of a later custom follow-up", async () => {
		const { harness, started, releaseSummary, releaseCheckpoint } = await createHeldCompaction();
		harness.setResponses([fauxAssistantMessage("user reply"), fauxAssistantMessage("custom reply")]);
		const settled = nextSettlement(harness);
		const compact = harness.session.compact();
		await started.promise;
		try {
			await harness.session.prompt("older user input", { messageId: "user" });
			await harness.session.sendCustomMessage(notification("later notification"), {
				triggerTurn: true,
				deliverAs: "followUp",
			});
		} finally {
			releaseSummary.release();
			releaseCheckpoint.release();
			await compact;
		}
		await settled;
		expect(deliveredInputs(harness)).toEqual(["old input", "older user input", "later notification"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it.each(["cancelled", "failed"] as const)(
		"retains custom and editable user input after %s manual compaction",
		async (outcome) => {
			const { harness, started, releaseSummary, releaseCheckpoint } = await createHeldCompaction({
				defaultSummary: outcome === "failed",
			});
			if (outcome === "failed") {
				harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" })]);
			}
			const compact = harness.session.compact();
			const rejected = expect(compact).rejects.toThrow(
				outcome === "cancelled" ? "Compaction cancelled" : "summary failed",
			);
			await started.promise;
			await harness.session.sendCustomMessage(notification("retained notification"), {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			await harness.session.prompt("retained input", { messageId: "retained" });
			if (outcome === "cancelled") harness.session.abortCompaction();
			releaseSummary.release();
			releaseCheckpoint.release();
			await rejected;

			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
			expect(deliveredInputs(harness)).toEqual(["old input"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			harness.session.updateQueuedMessage("retained", "edited retained input");
			expect(harness.session.getQueueState().messages.map((message) => message.message)).toEqual([
				"edited retained input",
			]);

			const settled = nextSettlement(harness);
			harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("resumed")));
			await harness.session.prompt("resume now");
			await settled;
			expect(deliveredInputs(harness)).toEqual([
				"old input",
				"retained notification",
				"edited retained input",
				"resume now",
			]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("clearQueue cancels both queued notifications and user input before completion", async () => {
		const { harness, started, releaseSummary, releaseCheckpoint } = await createHeldCompaction();
		const compact = harness.session.compact();
		await started.promise;
		try {
			await harness.session.sendCustomMessage(notification("cancel this notification"), { triggerTurn: true });
			await harness.session.prompt("cancel this input", { messageId: "cancel" });
			expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["cancel this input"] });
		} finally {
			releaseSummary.release();
			releaseCheckpoint.release();
			await compact;
		}
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(deliveredInputs(harness)).toEqual(["old input"]);
	});

	it("preserves omitted, false and nextTurn trigger behavior during manual compaction", async () => {
		const { harness, started, releaseSummary, releaseCheckpoint } = await createHeldCompaction();
		const compact = harness.session.compact();
		await started.promise;
		try {
			await harness.session.sendCustomMessage(notification("append by default"));
			await harness.session.sendCustomMessage(notification("context only"), { triggerTurn: false });
			await harness.session.sendCustomMessage(notification("next turn aside"), {
				triggerTurn: true,
				deliverAs: "nextTurn",
			});
			expect(deliveredInputs(harness)).toEqual(["old input", "append by default", "context only"]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			releaseSummary.release();
			releaseCheckpoint.release();
			await compact;
		}
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([fauxAssistantMessage("later reply")]);
		await harness.session.prompt("next user turn");
		expect(deliveredInputs(harness)).toEqual([
			"old input",
			"append by default",
			"context only",
			"next user turn",
			"next turn aside",
		]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it.each(["steer", "followUp"] as const)(
		"delivers one %s notification after automatic compaction",
		async (deliverAs) => {
			const { harness, started, releaseSummary, checkpoint, releaseCheckpoint } = await createHeldCompaction({
				automatic: true,
			});
			const requests: Array<{ compacting: boolean; completions: number; messages: string[] }> = [];
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
				(context) => {
					requests.push({
						compacting: harness.session.isCompacting,
						completions: harness.eventsOfType("compaction_end").length,
						messages: context.messages.map(getMessageText),
					});
					return fauxAssistantMessage("resumed original work");
				},
			]);
			if (deliverAs === "followUp") {
				harness.appendResponses([
					(context) => {
						requests.push({
							compacting: harness.session.isCompacting,
							completions: harness.eventsOfType("compaction_end").length,
							messages: context.messages.map(getMessageText),
						});
						return fauxAssistantMessage("notification handled");
					},
				]);
			}
			const run = harness.session.prompt("start work");
			await started.promise;
			try {
				expect(harness.eventsOfType("agent_start")).toHaveLength(1);
				expect(harness.faux.state.callCount).toBe(1);
				await harness.session.sendCustomMessage(notification("automatic notification"), {
					triggerTurn: true,
					deliverAs,
				});
				expect(harness.eventsOfType("agent_start")).toHaveLength(1);
				releaseSummary.release();
				await checkpoint.promise;
				expect(harness.faux.state.callCount).toBe(1);
			} finally {
				releaseSummary.release();
				releaseCheckpoint.release();
				await run;
			}
			expect(requests.map(({ compacting, completions }) => ({ compacting, completions }))).toEqual(
				Array.from({ length: deliverAs === "steer" ? 1 : 2 }, () => ({ compacting: false, completions: 1 })),
			);
			for (const request of requests) expect(request.messages.join("\n")).toContain("checkpoint for resumed work");
			expect(
				requests.map(
					(request) => request.messages.filter((message) => message === "automatic notification").length,
				),
			).toEqual(deliverAs === "steer" ? [1] : [0, 1]);
			expect(deliveredInputs(harness)).toEqual(["old input", "start work", "automatic notification"]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(2);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(deliverAs === "steer" ? 2 : 3);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("waits for settled handlers before waking a cancelled run with pending input", async () => {
		const requestStarted = gate();
		const releaseRequest = gate();
		const settling = gate();
		const releaseSettlement = gate();
		let sent = false;
		let queued = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						if (queued) return;
						queued = true;
						await harness.session.followUp("pending input", undefined, { messageId: "pending" });
					});
					pi.on("agent_settled", async () => {
						if (sent) return;
						sent = true;
						pi.sendMessage(notification("settled notification"), { triggerTurn: true, deliverAs: "followUp" });
						settling.release();
						await releaseSettlement.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				requestStarted.release();
				await releaseRequest.promise;
				return fauxAssistantMessage("cancelled reply");
			},
			fauxAssistantMessage("pending input reply"),
			fauxAssistantMessage("notification reply"),
		]);
		const run = harness.session.prompt("start");
		await requestStarted.promise;
		const aborted = harness.session.abort();
		releaseRequest.release();
		await settling.promise;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.getQueueState().messages.map((message) => message.id)).toEqual(["pending"]);
		} finally {
			releaseSettlement.release();
			await run;
			await aborted;
		}
		await harness.session.waitForIdle();
		expect(deliveredInputs(harness)).toEqual(["start", "pending input", "settled notification"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});
