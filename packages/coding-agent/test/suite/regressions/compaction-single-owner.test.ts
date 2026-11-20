import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionBeforeCompactEvent, SessionCompactEvent } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Remember the agreed implementation." }],
		timestamp: Date.now(),
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("The implementation is ready."),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("compaction ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps the first checkpoint without running another compactor and notifies every extension", async () => {
		const noOverride = vi.fn(() => undefined);
		const emptyOverride = vi.fn(() => ({}));
		const laterCompactor = vi.fn((event: SessionBeforeCompactEvent) => ({
			compaction: {
				summary: "A later compactor replaced the checkpoint.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
		const completed: Array<{ extension: string; event: SessionCompactEvent }> = [];
		const usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const details = { plugin: "first-compactor", lanes: ["audit", "execution"] };
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", noOverride);
					pi.on("session_before_compact", emptyOverride);
					pi.on("session_compact", (event) => {
						completed.push({ extension: "observer", event });
					});
				},
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "The first compactor owns this checkpoint.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details,
							usage,
						},
					}));
					pi.on("session_before_compact", laterCompactor);
					pi.on("session_compact", (event) => {
						completed.push({ extension: "owner", event });
					});
				},
				(pi) => {
					pi.on("session_before_compact", laterCompactor);
					pi.on("session_compact", (event) => {
						completed.push({ extension: "provider", event });
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compact();

		expect(noOverride).toHaveBeenCalledOnce();
		expect(emptyOverride).toHaveBeenCalledOnce();
		expect(laterCompactor.mock.calls.length).toBe(0);
		expect(result).toMatchObject({
			summary: "The first compactor owns this checkpoint.",
			details,
			usage,
		});
		const checkpoints = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			details,
			usage,
			fromHook: true,
		});
		expect(completed.map(({ extension }) => extension)).toEqual(["observer", "owner", "provider"]);
		for (const { event } of completed) {
			expect(event.fromExtension).toBe(true);
			expect(event.compactionEntry).toEqual(checkpoints[0]);
		}
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("honors cancellation before a compactor takes ownership", async () => {
		const compactor = vi.fn((event: SessionBeforeCompactEvent) => ({
			compaction: {
				summary: "This compactor must not run.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
		const completed = vi.fn();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
					pi.on("session_compact", completed);
				},
				(pi) => {
					pi.on("session_before_compact", compactor);
					pi.on("session_compact", completed);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(compactor).not.toHaveBeenCalled();
		expect(completed).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
