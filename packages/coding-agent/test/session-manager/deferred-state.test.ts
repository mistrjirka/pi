import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deferredStateForDetails } from "../../src/core/session-lazy-state.ts";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const tempFolders: string[] = [];
afterEach(() => {
	for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture(headerVersion = 3, malformedPrefix = false) {
	const folder = mkdtempSync(join(tmpdir(), "pi-deferred-state-"));
	tempFolders.push(folder);
	const file = join(folder, "session.jsonl");
	const state = JSON.stringify({
		version: 2,
		calls: [{ tool: "read", result: "Large replay state 🎓".repeat(38000) }],
		snippets: [],
		stdout: "",
	});
	const header = {
		type: "session",
		id: "test-lazy",
		version: headerVersion,
		cwd: folder,
		timestamp: "2025-01-01T00:00:00.000Z",
	};
	const toolResult = {
		type: "message",
		id: "code1234",
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "code",
			content: [{ type: "text", text: "done" }],
			details: { status: "ok", state, calls: [] },
			isError: false,
			timestamp: 1,
		},
	};
	const prefix = Buffer.from(`${JSON.stringify(header)}\n`);
	const malformed = malformedPrefix ? Buffer.from([0xff, 0x0a]) : Buffer.alloc(0);
	const payload = Buffer.from(`${JSON.stringify(toolResult)}\n`);
	writeFileSync(file, Buffer.concat([prefix, malformed, payload]));
	return { folder, file, state };
}
function stateAndDetails(entry: ReturnType<typeof loadEntriesFromFile>[number]) {
	if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected a tool-result entry");
	const details = entry.message.details as { state: string; status: string };
	return details;
}
describe("large session tool-state loading", () => {
	it("keeps big snapshot on disk and restores it exactly on demand", () => {
		const { file, state } = fixture();
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		const details = stateAndDetails(entries[1]!);
		const ref = deferredStateForDetails(details);
		expect(ref).toBeDefined();
		expect(ref!.length).toBeGreaterThan(500_000);
		expect(details.status).toBe("ok");
		expect(details.state).toBe(state);
		expect(JSON.parse(JSON.stringify(entries[1])).message.details.state).toBe(state);
	});
	it("handles invalid bytes before a large valid record without shifting offsets", () => {
		const { file, state } = fixture(3, true);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(stateAndDetails(entries[1]!).state).toBe(state);
	});
	it("offloads a newly appended code snapshot after it has been persisted", () => {
		const folder = mkdtempSync(join(tmpdir(), "pi-new-code-state-"));
		tempFolders.push(folder);
		const session = SessionManager.create(folder, folder);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const state = "code-tool-state-with-large-unicode-🍓".repeat(35000);
		const toolMessage = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "code",
			content: [{ type: "text" as const, text: "done" }],
			isError: false,
			timestamp: 2,
			details: { state, status: "ok" },
		};
		session.appendMessage(toolMessage);
		const entries = session.getEntries();
		const details = stateAndDetails(entries[1]!);
		expect(deferredStateForDetails(details)).toBeDefined();
		expect(Object.getOwnPropertyDescriptor(details, "state")?.get).toBeTypeOf("function");
		expect(details.state).toBe(state);
		const file = session.getSessionFile()!;
		expect(JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).message.details.state).toBe(state);
		expect(stateAndDetails(SessionManager.open(file).getEntries()[1]!).state).toBe(state);
	});
	it("preserves lazy snapshots through atomic v2 to v3 migration and append", () => {
		const { file, state } = fixture(2);
		const session = SessionManager.open(file);
		const entries = session.getEntries();
		const details = stateAndDetails(entries[0]!);
		expect(details.state).toBe(state);
		expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).version).toBe(3);
		expect(JSON.parse(readFileSync(file, "utf8").split("\n")[1]!).message.details.state).toBe(state);
		expect(deferredStateForDetails(details)).toBeDefined();
		session.appendSessionInfo("renamed");
		const reopened = SessionManager.open(file);
		expect(stateAndDetails(reopened.getEntries()[0]!).state).toBe(state);
	});
});
