import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { deferredStateForDetails } from "../../src/core/session-lazy-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";

function usage(tokens: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: tokens / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 100 },
	};
}

function foreground(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "code-1",
		toolName: "code",
		timestamp: 2,
		isError: false,
		content: [{ type: "text", text: "running" }],
		details: { state: "before", cell: { id: "cell-1", status: "running" } },
		nestedCalls: {
			complete: false,
			calls: [
				{ id: "code-1/1", name: "read", status: "ok", arguments: { path: "before.txt" } },
				{ id: "code-1/2", name: "write", status: "unfinished", arguments: { path: "changed.txt" } },
			],
		},
		usage: usage(3),
	};
}

function completion(state = "after"): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: "paused at safe checkpoint" }],
		details: { state, status: "suspended", cell: { id: "cell-1", status: "complete" } },
		nestedCalls: {
			complete: true,
			calls: [{ id: "code-1/2", name: "write", status: "ok", arguments: { path: "changed.txt" } }],
		},
		usage: usage(7),
	};
}

describe("deferred tool completion records", () => {
	const folders: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	it("updates the original projected result without adding an unmatched message or double usage", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const original = foreground();
		const targetId = session.appendMessage(original);
		const version = session.getContextVersion();
		const entry = session.appendToolCompletion("code-1", completion());
		expect(entry).toMatchObject({ type: "tool_completion", targetId, toolCallId: "code-1", toolName: "code" });
		expect(session.getContextVersion()).toBe(version);
		expect(session.appendToolCompletion("code-1", completion())).toBeUndefined();
		const messages = session.buildSessionProjection().messages;
		expect(messages).toHaveLength(2);
		const result = messages[1];
		if (result?.role !== "toolResult") throw new Error("Missing projected result");
		expect(result.toolCallId).toBe("code-1");
		expect(result.content).toEqual(completion().content);
		expect(result.details).toEqual(completion().details);
		expect(result.nestedCalls?.calls.map((call) => [call.id, call.status])).toEqual([
			["code-1/1", "ok"],
			["code-1/2", "ok"],
		]);
		expect(result.nestedCalls?.complete).toBe(true);
		expect(result.usage?.totalTokens).toBe(10);
		expect(original.nestedCalls?.calls[1]?.status).toBe("unfinished");
		expect(original.usage?.totalTokens).toBe(3);
		expect(getUsageCostBreakdown(session.getEntries())).toEqual([{ key: "Tools/summaries", tokens: 10, cost: 0.1 }]);
		session.appendContextEdit(targetId, { content: "shortened" });
		const editedResult = session.buildSessionProjection().messages[1];
		if (editedResult?.role !== "toolResult") throw new Error("Missing edited result");
		expect(editedResult.content).toEqual([{ type: "text", text: "shortened" }]);
	});

	it("keeps a later completion visible after compaction removes its original call and result", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(foreground());
		const correctionId = session.appendMessage({ role: "user", content: "corrected task", timestamp: 3 });
		session.appendCompaction("Work is still pending", correctionId, 1000);
		session.appendToolCompletion("code-1", completion("private checkpoint"));
		const messages = session.buildSessionProjection().messages;
		expect(messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "custom"]);
		const observation = messages[2];
		if (observation?.role !== "custom") throw new Error("Missing completion observation");
		expect(observation).toMatchObject({
			customType: "tool_completion",
			display: true,
			details: { toolCallId: "code-1", toolName: "code" },
		});
		expect(observation.content).toEqual([
			{ type: "text", text: "Deferred code result (code-1):" },
			...completion().content,
		]);
		expect(JSON.stringify(messages)).not.toContain("private checkpoint");
		expect(convertToLlm(messages).map((message) => message.role)).toEqual(["user", "user", "user"]);
		expect(getUsageCostBreakdown(session.getEntries())).toEqual([{ key: "Tools/summaries", tokens: 10, cost: 0.1 }]);
		const nextUser = session.appendMessage({ role: "user", content: "continue", timestamp: 4 });
		session.appendCompaction("Work reached the checkpoint", nextUser, 1000);
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
	});

	it("requires an original result on the active branch", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(foreground());
		const version = session.getContextVersion();
		session.branch(userId);
		expect(session.getContextVersion()).toBeGreaterThan(version);
		expect(() => session.appendToolCompletion("code-1", completion())).toThrow("not on the active branch");
		expect(session.getEntries().filter((entry) => entry.type === "tool_completion")).toHaveLength(0);
	});

	it("rolls back a failed append so the same completion can be retried", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(foreground());
		const leaf = session.getLeafId();
		const persist = vi.spyOn(session, "_persist").mockImplementationOnce(() => {
			throw new Error("disk unavailable");
		});
		expect(() => session.appendToolCompletion("code-1", completion())).toThrow("disk unavailable");
		expect(session.getLeafId()).toBe(leaf);
		expect(session.getEntries()).toHaveLength(1);
		persist.mockRestore();
		expect(session.appendToolCompletion("code-1", completion())).toBeDefined();
		expect(session.getEntries()).toHaveLength(2);
	});

	it("keeps large completion checkpoints lazy across append, reload, and branch extraction", () => {
		const folder = mkdtempSync(join(tmpdir(), "pi-tool-completion-"));
		folders.push(folder);
		const session = SessionManager.create(folder, folder);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(foreground());
		const state = "checkpoint-🍓".repeat(50_000);
		const entry = session.appendToolCompletion("code-1", completion(state));
		if (!entry) throw new Error("Missing completion");
		const details = entry.result.details as { state: string };
		expect(deferredStateForDetails(details)).toBeDefined();
		expect(details.state).toBe(state);
		const file = session.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		const reopened = SessionManager.open(file);
		const restored = reopened.getEntries().find((item) => item.type === "tool_completion");
		if (!restored || restored.type !== "tool_completion") throw new Error("Missing restored completion");
		const restoredDetails = restored.result.details as { state: string };
		expect(deferredStateForDetails(restoredDetails)).toBeDefined();
		expect(restoredDetails.state).toBe(state);
		expect(reopened.appendToolCompletion("code-1", completion())).toBeUndefined();
		const fork = reopened.createBranchedSession(restored.id);
		if (!fork) throw new Error("Missing fork");
		expect(restoredDetails.state).toBe(state);
		expect(readFileSync(fork, "utf8")).toContain("tool_completion");
		const projected = SessionManager.open(fork).buildSessionProjection().messages[1];
		if (projected?.role !== "toolResult") throw new Error("Missing reopened result");
		expect((projected.details as { state: string }).state).toBe(state);
	});
});
