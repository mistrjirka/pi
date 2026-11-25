import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("accepted user steering notifications", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("notifies code tool contexts only for admitted steering and preserves the active run", async () => {
		const entered = gate();
		const release = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						if (event.text === "handled") return { action: "handled" };
						if (event.text === "rewrite") return { action: "transform", text: "accepted correction" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				entered.release();
				await release.promise;
				return fauxAssistantMessage("old");
			},
			fauxAssistantMessage("corrected"),
			fauxAssistantMessage("follow-up"),
		]);
		const context = harness.session.extensionRunner.createToolContext("code-test", undefined);
		const pendingAtNotification: boolean[] = [];
		const unsubscribe = context.onUserSteering?.(() => {
			pendingAtNotification.push(context.hasPendingUserSteering?.() ?? false);
		});
		expect(unsubscribe).toBeTypeOf("function");
		const running = harness.session.prompt("start");
		try {
			await entered.promise;
			await harness.session.steer("handled", undefined, { source: "rpc" });
			await harness.session.followUp("later", undefined, { source: "rpc" });
			expect(pendingAtNotification).toEqual([]);
			expect(context.hasPendingUserSteering?.()).toBe(false);
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			await harness.session.steer("rewrite", undefined, { source: "rpc" });
			await running;
			expect(pendingAtNotification).toEqual([true]);
			expect(getUserTexts(harness)).toEqual(["start", "accepted correction", "later"]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.eventsOfType("agent_end")).toHaveLength(1);
			expect(harness.session.agent.state.errorMessage).toBeUndefined();
		} finally {
			unsubscribe?.();
			release.release();
			await running;
		}
	});
});
