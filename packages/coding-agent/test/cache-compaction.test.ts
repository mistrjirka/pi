import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type CompactionCacheRequest,
	compactCachedRequest,
	retainUnseenCompactionEntries,
} from "../src/core/cache-compaction.ts";
import { prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function fixture() {
	const faux = fauxProvider({ models: [{ id: "summary", maxTokens: 12000 }] });
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Important original instructions ".repeat(30), timestamp: 1 });
	const sourceEntryId = manager.appendMessage(fauxAssistantMessage("Earlier completed work"));
	manager.appendMessage({ role: "user", content: "Continue the work", timestamp: 2 });
	const pendingId = manager.appendMessage(
		fauxAssistantMessage([fauxToolCall("wait", {}, { id: "pending" })], { stopReason: "toolUse" }),
	);
	const preparation = prepareCompaction(manager.getBranch(), {
		enabled: true,
		reserveTokens: 1000,
		keepRecentTokens: 1,
	})!;
	const request: CompactionCacheRequest = {
		model: faux.getModel(),
		sessionId: manager.getSessionId(),
		sourceEntryId,
		startedAt: 0,
		ttlMs: 300_000,
		context: normalizeContext({
			messages: [
				{ role: "system", content: "Original system", toolsAdded: [], timestamp: 0 },
				{ role: "user", content: "Important original instructions", timestamp: 1 },
				fauxAssistantMessage("Earlier completed work"),
			],
		}),
		options: { sessionId: manager.getSessionId(), cacheRetention: "long", maxTokens: 100, reasoning: "high" },
	};
	return { faux, manager, request, preparation, pendingId };
}

describe("cache-aware summary requests", () => {
	it("preserves every original prompt message and options while using the full output allowance", async () => {
		const { faux, request, preparation } = fixture();
		faux.setResponses([fauxAssistantMessage("Complete checkpoint")]);
		let sent: TranscriptContext | undefined;
		let options: SimpleStreamOptions | undefined;
		const response = await compactCachedRequest(
			{
				streamSideQuestion: (model, context, requestOptions) => {
					sent = normalizeContext(context);
					options = requestOptions;
					return faux.provider.streamSimple(model, normalizeContext(context), requestOptions);
				},
			},
			request,
			preparation,
			new AbortController().signal,
		);
		expect(sent?.messages.slice(0, -1)).toEqual(request.context.messages);
		expect(request.context.messages).toHaveLength(3);
		expect(options).toMatchObject({
			sessionId: request.sessionId,
			cacheRetention: "long",
			reasoning: "high",
			maxTokens: request.model.maxTokens,
			maxRetries: 0,
			disableContinuation: true,
		});
		expect(response.summary).toContain("Complete checkpoint");
		expect(response.details).toMatchObject({ method: "cache-aware", complete: true });
	});

	it("preserves serialized Anthropic system, tool definitions and original user blocks", async () => {
		const { faux, request, preparation } = fixture();
		const model: Model<"anthropic-messages"> = {
			...request.model,
			id: "claude-opus-4-6",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "http://127.0.0.1:9",
			reasoning: true,
		};
		request.model = model;
		request.context = normalizeContext({
			messages: [
				{
					role: "system",
					content: "Keep the exact original system prompt.",
					toolsAdded: [
						{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
					],
					timestamp: 0,
				},
				{
					role: "user",
					content: [{ type: "text", text: "Original user block with no added newline" }],
					timestamp: 1,
				},
			],
		});
		let summaryContext: TranscriptContext | undefined;
		faux.setResponses([fauxAssistantMessage("Complete checkpoint")]);
		await compactCachedRequest(
			{
				streamSideQuestion: (_model, context, options) => {
					summaryContext = normalizeContext(context);
					return faux.provider.streamSimple(faux.getModel(), normalizeContext(context), options);
				},
			},
			request,
			preparation,
			new AbortController().signal,
		);
		interface Payload {
			system: unknown;
			tools: unknown;
			messages: unknown[];
		}
		async function capture(context: TranscriptContext): Promise<Payload> {
			let payload: Payload | undefined;
			await streamAnthropic(model, context, {
				...request.options,
				apiKey: "fake-key",
				maxRetries: 0,
				onPayload: (value) => {
					payload = structuredClone(value) as Payload;
					throw new Error("Captured before HTTP");
				},
			}).result();
			if (!payload) throw new Error("Expected serialized payload");
			return payload;
		}
		const original = await capture(request.context);
		const compacting = await capture(summaryContext!);
		expect(compacting.system).toEqual(original.system);
		expect(compacting.tools).toEqual(original.tools);
		// Cache markers move to the new final block. Every original content block is unchanged.
		const withoutCacheMarkers = (value: unknown) =>
			JSON.parse(JSON.stringify(value, (key, entry) => (key === "cache_control" ? undefined : entry)));
		expect(withoutCacheMarkers(compacting.messages.slice(0, original.messages.length))).toEqual(
			withoutCacheMarkers(original.messages),
		);
		expect(compacting.messages).toHaveLength(original.messages.length + 1);
	});

	it.each(["length", "error", "aborted"] as const)("does not commit a %s response", async (stopReason) => {
		const { faux, request, preparation } = fixture();
		faux.setResponses([fauxAssistantMessage("Incomplete checkpoint", { stopReason })]);
		await expect(
			compactCachedRequest(
				{ streamSideQuestion: faux.provider.streamSimple },
				request,
				preparation,
				new AbortController().signal,
			),
		).rejects.toThrow();
	});

	it("rejects empty and tool-producing checkpoints", async () => {
		const { faux, request, preparation } = fixture();
		for (const message of [
			fauxAssistantMessage(""),
			fauxAssistantMessage([fauxToolCall("write", { text: "unexpected" })]),
		]) {
			faux.setResponses([message]);
			await expect(
				compactCachedRequest(
					{ streamSideQuestion: faux.provider.streamSimple },
					request,
					preparation,
					new AbortController().signal,
				),
			).rejects.toThrow();
		}
	});

	it("retains uncaptured input and the whole pending tool batch even with a later proposed cut", () => {
		const { manager, request, preparation, pendingId } = fixture();
		const result = retainUnseenCompactionEntries(
			{ ...preparation, firstKeptEntryId: pendingId },
			manager.getBranch(),
			request,
		);
		const entries = manager.getBranch();
		expect(result.firstKeptEntryId).toBe(
			entries[entries.findIndex((entry) => entry.id === request.sourceEntryId) + 1].id,
		);
		expect(result.firstKeptEntryId).not.toBe(pendingId);
	});
});

describe("compaction maintenance preferences", () => {
	it("defaults to cache-aware compaction before expiry and preserves explicit older choices", () => {
		const defaults = SettingsManager.inMemory();
		expect(defaults.getCompactionMethod()).toBe("cache-aware");
		expect(defaults.getCacheMaintenanceMode()).toBe("compact");
		expect(defaults.getCompactionEnabled()).toBe(true);
		expect(SettingsManager.inMemory({ cacheWarming: "off" }).getCacheMaintenanceMode()).toBe("off");
		expect(SettingsManager.inMemory({ cacheWarming: "streaming" }).getCacheMaintenanceMode()).toBe("keep-warm");
		expect(SettingsManager.inMemory({ cacheWarming: "idle" }).getCacheMaintenanceMode()).toBe("keep-warm");
		const disabled = SettingsManager.inMemory({ compaction: { enabled: false }, cacheMaintenance: "compact" });
		expect(disabled.getCompactionEnabled()).toBe(false);
		defaults.setCompactionMethod("extension");
		defaults.setCacheMaintenanceMode("off");
		expect(defaults.getCompactionMethod()).toBe("extension");
		expect(defaults.getCacheMaintenanceMode()).toBe("off");
	});
});
