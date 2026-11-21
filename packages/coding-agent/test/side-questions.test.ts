import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type Message,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getSideQuestionSnapshot } from "../src/core/side-questions.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const sessions: AgentSession[] = [];

async function fixture(
	options: { extensions?: ExtensionFactory[]; live?: boolean; safe?: boolean; maintenance?: boolean } = {},
) {
	const faux = fauxProvider({
		models: [
			{ id: "test-model", reasoning: true },
			{ id: "other-model", reasoning: true },
		],
	});
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const calls: { context: TranscriptContext; options: SimpleStreamOptions | undefined }[] = [];
	const provider: Provider = {
		...faux.provider,
		streamSimple: (model, context, requestOptions) => {
			if (options.maintenance) {
				void requestOptions?.onProviderStreamEvent?.({ type: "prompt_cache_timing", ttlMs: 300_000 }, model);
			}
			return faux.provider.streamSimple(model, context, requestOptions);
		},
		...(options.safe === false
			? {}
			: {
					streamSideQuestion: (model, context, requestOptions) => {
						calls.push({ context, options: requestOptions });
						return faux.provider.streamSimple(model, context, requestOptions);
					},
					sideQuestionUsesLiveContext: options.live,
				}),
	};
	runtime.registerNativeProvider(provider);
	await runtime.getAvailable(provider.id);
	const sessionManager = SessionManager.inMemory();
	const extensionsResult = await createTestExtensionsResult(options.extensions ?? []);
	const { session } = await createAgentSession({
		cwd: "/tmp",
		modelRuntime: runtime,
		model: faux.getModel(),
		thinkingLevel: "high",
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: options.maintenance ?? false, keepRecentTokens: 1 },
			retry: { enabled: false },
			...(options.maintenance ? { cacheMaintenance: "compact" } : { cacheWarming: "off" }),
		}),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: ["read"],
	});
	sessions.push(session);
	const snapshot = (signal?: AbortSignal) => getSideQuestionSnapshot(sessionManager, { signal });
	return { session, sessionManager, runtime, faux, calls, snapshot };
}

afterEach(() => {
	while (sessions.length > 0) sessions.pop()?.dispose();
	vi.useRealTimers();
});

describe("side-question snapshots", () => {
	it("runs the idle expiry timer after a prior checkpoint and custom-message projection", async () => {
		vi.useFakeTimers();
		const f = await fixture({ maintenance: true });
		f.sessionManager.appendCompaction("An existing checkpoint", null, 100);
		f.session.refreshContext();
		await f.session.sendCustomMessage({ customType: "child", content: "Earlier child message", display: true });
		f.faux.setResponses([fauxAssistantMessage("Main answer"), fauxAssistantMessage("Expiry checkpoint")]);
		await f.session.prompt("Continue from the existing checkpoint");
		expect(f.session.cacheMaintenanceStatus, JSON.stringify(f.session.cacheMaintenanceStatus)).toMatchObject({
			state: "scheduled",
			action: "compact",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(
			f.session.messages.some(
				(message) => message.role === "compactionSummary" && message.summary.includes("Expiry checkpoint"),
			),
		).toBe(true);
		expect(f.faux.state.callCount).toBe(2);
	});

	it("captures the final transformed request, appends a completed answer, and never reruns context hooks", async () => {
		let hooks = 0;
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.on("context", (event) => {
						hooks++;
						return {
							messages: event.messages.map((message) =>
								message.role === "user" ? { ...message, content: "filtered user text" } : message,
							),
						};
					});
					pi.on("context_with_system", (event) => {
						hooks++;
						return {
							messages: event.messages.map((message) =>
								message.role === "system" ? { ...message, toolsAdded: [] } : message,
							),
						};
					});
					pi.on("before_agent_start", () => ({ systemPrompt: "forced prompt after context hooks" }));
				},
			],
		});
		let sent: TranscriptContext | undefined;
		f.faux.setResponses([
			(context) => {
				sent = structuredClone(context);
				return fauxAssistantMessage("Main completed answer");
			},
		]);
		await f.session.prompt("Raw user text");
		const before = structuredClone(f.sessionManager.getEntries());
		const hooksBefore = hooks;
		const privateAbort = new AbortController();
		const first = await f.snapshot(privateAbort.signal);
		expect(first.source).toBe("request-prefix");
		expect(first.context.messages.slice(0, -1)).toEqual(sent?.messages);
		expect(first.context.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Main completed answer" }],
		});
		expect(JSON.stringify(first.context)).toContain("forced prompt after context hooks");
		expect(JSON.stringify(first.context)).not.toContain("Raw user text");
		expect(first.options).toMatchObject({
			sessionId: f.sessionManager.getSessionId(),
			reasoning: "high",
			disableContinuation: true,
			signal: privateAbort.signal,
		});
		expect(first.options).not.toHaveProperty("onPayload");
		expect(first.options).not.toHaveProperty("onResponse");
		expect(first.options).not.toHaveProperty("onProviderStreamEvent");
		first.context.messages.length = 0;
		expect((await f.snapshot()).context.messages.length).toBeGreaterThan(1);
		expect(hooks).toBe(hooksBefore);
		expect(f.sessionManager.getEntries()).toEqual(before);
	});

	it("excludes incomplete tool batches, then includes the complete batch through core projection", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("First answer")]);
		await f.session.prompt("Main");
		f.sessionManager.appendMessage(
			fauxAssistantMessage(
				[fauxToolCall("read", { path: "a" }, { id: "a" }), fauxToolCall("read", { path: "b" }, { id: "b" })],
				{ stopReason: "toolUse" },
			),
		);
		f.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text", text: "First result" }],
			isError: false,
			timestamp: 1,
		});
		const pending = await f.snapshot();
		expect(pending.pendingMessagesOmitted).toBe(true);
		expect(JSON.stringify(pending.context)).not.toContain("First result");
		f.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "b",
			toolName: "read",
			content: [{ type: "text", text: "Second result" }],
			isError: false,
			timestamp: 2,
		});
		const complete = await f.snapshot();
		expect(complete.pendingMessagesOmitted).toBe(false);
		expect(complete.source).toBe("current-session");
		expect(JSON.stringify(complete.context)).toContain("First result");
		expect(JSON.stringify(complete.context)).toContain("Second result");
	});

	it("invalidates an earlier edited message even though its source entry id does not change", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("Answer")]);
		await f.session.prompt("Old user text");
		const user = f.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(user).toBeDefined();
		f.sessionManager.appendContextEdit(user!.id, { content: "Edited user text" });
		expect(f.sessionManager.buildSessionProjection().entries.some((entry) => entry.sourceEntry.id === user!.id)).toBe(
			true,
		);
		const snapshot = await f.snapshot();
		expect(snapshot.source).toBe("current-session");
		expect(JSON.stringify(snapshot.context)).toContain("Edited user text");
		expect(JSON.stringify(snapshot.context)).not.toContain("Old user text");
	});

	it("rebuilds compacted context and supports old conversations without system messages", async () => {
		const f = await fixture();
		f.sessionManager.appendMessage({ role: "user", content: "Old conversation", timestamp: 1 });
		const entriesBefore = structuredClone(f.sessionManager.getEntries());
		const old = await f.snapshot();
		expect(f.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(old.source).toBe("current-session");
		expect(old.context.messages[0]?.role).toBe("system");
		expect(old.context.messages[0]).toHaveProperty("toolsAdded");
		f.faux.setResponses([fauxAssistantMessage("Answer")]);
		await f.session.prompt("New main turn");
		f.sessionManager.appendCompaction("A compacted summary", null, 100);
		const compacted = await f.snapshot();
		expect(compacted.source).toBe("current-session");
		expect(JSON.stringify(compacted.context)).toContain("A compacted summary");
		expect(JSON.stringify(compacted.context)).not.toContain("Old conversation");
	});

	it("refuses to bypass custom filters on cold resume or after context edits", async () => {
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.on("context", (event) => ({ messages: event.messages }));
				},
			],
		});
		await expect(f.snapshot()).rejects.toThrow("Run a normal turn");
		f.faux.setResponses([fauxAssistantMessage("Answer")]);
		await f.session.prompt("Main");
		await expect(f.snapshot()).resolves.toMatchObject({ source: "request-prefix" });
		const user = f.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		f.sessionManager.appendContextEdit(user!.id, { content: "Changed" });
		await expect(f.snapshot()).rejects.toThrow("Run a normal turn");
	});

	it("uses the newly selected model instead of the previous captured physical model", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("Answer")]);
		await f.session.prompt("Main");
		const next = f.faux.getModel("other-model");
		expect(next).toBeDefined();
		await f.session.setModel(next!);
		const snapshot = await f.snapshot();
		expect(snapshot.model.id).toBe("other-model");
		expect(snapshot.source).toBe("current-session");
	});

	it("uses native live context without replaying custom context or payload hooks", async () => {
		let hooks = 0;
		const f = await fixture({
			live: true,
			extensions: [
				(pi) => {
					pi.on("context", () => {
						hooks++;
					});
					pi.on("before_provider_request", () => {
						hooks++;
					});
					pi.on("before_provider_headers", () => {
						hooks++;
					});
				},
			],
		});
		const snapshot = await f.snapshot();
		expect(snapshot.source).toBe("native-live");
		expect(snapshot.context.messages).toEqual([]);
		expect(snapshot.options.sessionId).toBe(f.sessionManager.getSessionId());
		expect(hooks).toBe(0);
		expect(f.calls).toHaveLength(0);
	});

	it.each(["context edit", "compaction"] as const)(
		"rejects stale native context after a boundary %s until a new main request",
		async (change) => {
			let mutate = true;
			let hooks = 0;
			let lifecycleEvents = 0;
			const f = await fixture({
				live: true,
				extensions: [
					(pi) => {
						pi.on("context", () => {
							hooks++;
						});
						pi.on("before_provider_request", () => {
							hooks++;
						});
						pi.on("before_provider_headers", () => {
							hooks++;
						});
						pi.on("session_tree", () => {
							lifecycleEvents++;
						});
						pi.on("session_compact", () => {
							lifecycleEvents++;
						});
						pi.on("turn_end", (event) => {
							if (!mutate) return;
							mutate = false;
							if (change === "compaction") {
								return {
									entries: [{ type: "compaction", summary: "Changed context", firstKeptEntryId: null }],
								};
							}
							const user = event.context.contextEntries.find(
								(entry) => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "user",
							);
							expect(user).toBeDefined();
							return {
								entries: [
									{
										type: "context_edit",
										targetId: user!.sourceEntry.id,
										replacement: { content: "Changed context" },
									},
								],
							};
						});
					},
				],
			});
			f.faux.setResponses([
				fauxAssistantMessage("Answer"),
				(context) => {
					expect(JSON.stringify(context)).toContain("Changed context");
					expect(JSON.stringify(context)).not.toContain("Old context");
					return fauxAssistantMessage("Fresh answer");
				},
			]);
			await f.session.prompt("Old context");
			const entries = structuredClone(f.sessionManager.getEntries());
			const hooksBefore = hooks;
			await expect(f.snapshot()).rejects.toThrow("Run a normal turn");
			expect(f.sessionManager.getEntries()).toEqual(entries);
			expect(hooks).toBe(hooksBefore);
			expect(lifecycleEvents).toBe(0);
			expect(f.calls).toHaveLength(0);
			await f.session.prompt("Continue with changed context");
			const hooksAfter = hooks;
			await expect(f.snapshot()).resolves.toMatchObject({ source: "native-live" });
			expect(hooks).toBe(hooksAfter);
		},
	);

	it("rejects unsafe provider hooks for generic replay and honors pre-cancelled requests", async () => {
		const f = await fixture({
			extensions: [
				(pi) => {
					pi.on("before_provider_request", (event) => event.payload);
				},
			],
		});
		expect(f.session.compactionMethods.find((method) => method.id === "cache-aware")).toMatchObject({
			available: false,
			reason: "Custom provider payload or header hooks cannot be replayed safely",
		});
		await expect(f.snapshot()).rejects.toThrow("custom provider payload or header hooks");
		const aborted = new AbortController();
		aborted.abort(new Error("cancelled aside"));
		await expect(f.snapshot(aborted.signal)).rejects.toThrow("cancelled aside");
	});
});

describe("safe provider dispatch", () => {
	it("preserves native capability through metadata overlays and removes it for ordinary stream overrides", async () => {
		const f = await fixture({ live: true });
		const base = f.runtime.getProvider(f.faux.provider.id)!;
		const config = await ModelConfig.load(undefined);
		const renamed = composeModelProvider(base.id, base, config, { name: "Renamed provider" });
		expect(renamed.sideQuestionUsesLiveContext).toBe(true);
		expect(renamed.streamSideQuestion).toBeDefined();
		f.faux.setResponses([fauxAssistantMessage("Native aside")]);
		const snapshot = await f.snapshot();
		const reply = await renamed.streamSideQuestion!(snapshot.model, snapshot.context, snapshot.options).result();
		expect(reply.stopReason).toBe("stop");
		expect(f.calls).toHaveLength(1);
		const overridden = composeModelProvider(base.id, base, config, {
			api: f.faux.api,
			streamSimple: () => {
				throw new Error("ordinary native agent must not be called");
			},
		});
		expect(overridden.streamSideQuestion).toBeUndefined();
		expect(overridden.sideQuestionUsesLiveContext).toBeUndefined();
	});

	it("requires explicit capability and never falls back to ordinary native streaming", async () => {
		const f = await fixture({ safe: false });
		f.faux.setResponses([fauxAssistantMessage("must not be called")]);
		const result = await new ModelRegistry(f.runtime)
			.streamSideQuestion(f.faux.getModel(), { messages: [] })
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("does not support safe side questions");
		expect(f.faux.state.callCount).toBe(0);
	});

	it("uses registry authentication, private cancellation and disables continuation", async () => {
		const f = await fixture();
		f.faux.setResponses([fauxAssistantMessage("Aside answer")]);
		const signal = new AbortController().signal;
		const context: { messages: Message[] } = { messages: [{ role: "user", content: "Question", timestamp: 1 }] };
		const result = await new ModelRegistry(f.runtime)
			.streamSideQuestion(f.faux.getModel(), context, {
				sessionId: "shared-cache",
				signal,
				disableContinuation: false,
				transformHeaders: (headers) => ({ ...headers, "x-aside": "yes" }),
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(f.calls[0]?.options).toMatchObject({
			sessionId: "shared-cache",
			signal,
			disableContinuation: true,
			headers: { "x-aside": "yes" },
		});
		expect(f.calls[0]?.options).not.toHaveProperty("transformHeaders");
		expect(f.calls[0]?.context.messages).toEqual(context.messages);
	});
});
