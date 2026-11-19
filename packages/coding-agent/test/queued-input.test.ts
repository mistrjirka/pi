import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedInputs } from "../src/core/queued-input.ts";

describe("pending input mutations", () => {
	const queues: QueuedInputs[] = [];
	afterEach(() => {
		for (const queue of queues.splice(0)) queue.dispose();
	});

	function setup() {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("No provider request expected");
			},
		});
		const changes: number[] = [];
		const queue = new QueuedInputs(agent, () => changes.push(queue.getState().revision));
		queues.push(queue);
		return { agent, queue, changes };
	}

	it("edits and cancels duplicate text by identity without touching unrelated inputs", () => {
		const { agent, queue, changes } = setup();
		queue.add("same", undefined, "steer", "a");
		queue.add("same", undefined, "steer", "b");
		const before = queue.getState();
		queue.update("b", "edited", undefined, before.revision);
		expect(queue.getState().messages.map((message) => [message.id, message.message])).toEqual([
			["a", "same"],
			["b", "edited"],
		]);
		queue.remove("a", queue.getState().revision);
		expect(queue.getState().messages.map((message) => message.id)).toEqual(["b"]);
		expect(agent.peekQueuedMessages()).toHaveLength(1);
		expect(changes).toEqual([1, 2, 3, 4]);
	});

	it("combines consecutive inputs in place and preserves all attachments and the first ID", () => {
		const { queue } = setup();
		const first: ImageContent = { type: "image", data: "first-image", mimeType: "image/png" };
		const second: ImageContent = { type: "image", data: "second-image", mimeType: "image/jpeg" };
		queue.add("first", [first], "followUp", "a");
		queue.add("second", [second], "followUp", "b");
		queue.add("third", undefined, "followUp", "c");
		queue.combine(["a", "b"], queue.getState().revision);
		expect(queue.getState().messages).toEqual([
			{ id: "a", mode: "followUp", message: "first\n\nsecond", images: [first, second] },
			{ id: "c", mode: "followUp", message: "third", images: undefined },
		]);
		queue.update("a", "changed text");
		expect(queue.getState().messages[0].images).toEqual([first, second]);
		queue.update("a", "no attachments", []);
		expect(queue.getState().messages[0].images).toEqual([]);
	});

	it("rejects stale revisions, repeated IDs, nonadjacent targets and mixed modes without partial mutation", () => {
		const { queue } = setup();
		queue.add("first", undefined, "steer", "a");
		queue.add("second", undefined, "steer", "b");
		queue.add("third", undefined, "steer", "c");
		queue.add("later", undefined, "followUp", "d");
		const before = queue.getState();
		expect(() => queue.update("a", "stale", undefined, before.revision - 1)).toThrow("Queue changed");
		expect(() => queue.combine(["a", "c"])).toThrow("consecutive");
		expect(() => queue.combine(["a", "a"])).toThrow("distinct");
		expect(() => queue.combine(["a", "d"])).toThrow("same delivery mode");
		expect(() => queue.combine(["b", "a"])).toThrow("consecutive");
		expect(() => queue.add("duplicate", undefined, "steer", "a")).toThrow("already exists");
		expect(queue.getState()).toEqual(before);
	});

	it("does not combine across a pending extension message", () => {
		const { queue, agent } = setup();
		queue.add("first", undefined, "steer", "a");
		agent.steer({ role: "user", content: "extension", timestamp: Date.now() });
		queue.add("second", undefined, "steer", "b");
		expect(() => queue.combine(["a", "b"])).toThrow("consecutive");
		expect(queue.getState().messages.map((message) => message.id)).toEqual(["a", "b"]);
	});

	it("removes claimed inputs before awaited message events and rejects later edits", async () => {
		const { queue, agent } = setup();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		agent.state.messages = [fauxAssistantMessage("previous")];
		agent.subscribe(async (event) => {
			if (event.type === "agent_start") await held;
		});
		queue.add("next", undefined, "followUp", "a");
		const run = agent.continue();
		expect(queue.getState().messages).toEqual([]);
		expect(() => queue.update("a", "too late")).toThrow("no longer pending");
		expect(() => queue.remove("a")).toThrow("no longer pending");
		agent.abort();
		release();
		await run;
	});

	it("reflects core queue clearing and can restore a prompt that failed before starting", () => {
		const { queue, agent } = setup();
		queue.add("first", undefined, "followUp", "a");
		queue.add("second", undefined, "followUp", "b");
		const claimed = queue.takeNext();
		expect(claimed).toBeDefined();
		queue.restore(claimed!);
		expect(queue.getState().messages.map((message) => message.id)).toEqual(["a", "b"]);
		agent.clearFollowUpQueue();
		expect(queue.getState().messages).toEqual([]);
	});
});
