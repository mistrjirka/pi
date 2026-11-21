import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProviderUsageSnapshot, readProviderUsage } from "../src/core/provider-usage.ts";

const snapshot: ProviderUsageSnapshot = {
	provider: "doppelclaude",
	status: "ok",
	accountId: "account-a",
	observedAt: 1_700_000_000_000,
	source: "sdk",
	limits: [{ kind: "session", label: "5h", percent: 12, resetAt: null }],
};

describe("account-bound provider usage", () => {
	afterEach(() => vi.useRealTimers());

	it("reads the requested session provider without converting unknown resets to now", async () => {
		const read = vi.fn(async () => snapshot);
		const result = await readProviderUsage({
			provider: "doppelclaude",
			modelId: "model-a",
			read,
			isCurrent: () => true,
		});
		expect(result).toBe(snapshot);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]).toEqual([expect.objectContaining({ provider: "doppelclaude", modelId: "model-a" })]);
		expect(result.limits[0].resetAt).toBeNull();
	});

	it("keeps unsupported usage unknown rather than claiming a full allowance", async () => {
		const result = await readProviderUsage({
			provider: "other",
			modelId: "model-a",
			read: async () => undefined,
			isCurrent: () => true,
		});
		expect(result).toMatchObject({ provider: "other", status: "unavailable", observedAt: null, limits: [] });
	});

	it("rejects another provider's result", async () => {
		const result = await readProviderUsage({
			provider: "other",
			modelId: "model-a",
			read: async () => snapshot,
			isCurrent: () => true,
		});
		expect(result.status).toBe("unavailable");
		expect(result.accountId).toBeUndefined();
	});

	it("discards a late response after the session or selected account changes", async () => {
		let current = true;
		let finish: (value: ProviderUsageSnapshot) => void = () => {};
		const pending = readProviderUsage({
			provider: "doppelclaude",
			modelId: "model-a",
			isCurrent: () => current,
			read: () =>
				new Promise<ProviderUsageSnapshot>((resolve) => {
					finish = resolve;
				}),
		});
		current = false;
		finish(snapshot);
		expect(await pending).toMatchObject({ status: "unavailable", limits: [] });
	});

	it("times out only the usage read and leaves the running model signal alone", async () => {
		vi.useFakeTimers();
		const modelController = new AbortController();
		let usageSignal: AbortSignal | undefined;
		const pending = readProviderUsage({
			provider: "doppelclaude",
			modelId: "model-a",
			isCurrent: () => true,
			timeoutMs: 50,
			read: ({ signal }) => {
				usageSignal = signal;
				return new Promise<ProviderUsageSnapshot>(() => {});
			},
		});
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({ status: "error", error: "Usage request timed out", limits: [] });
		expect(usageSignal?.aborted).toBe(true);
		expect(modelController.signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps provider authentication error details off the RPC wire", async () => {
		const result = await readProviderUsage({
			provider: "doppelclaude",
			modelId: "model-a",
			isCurrent: () => true,
			read: async () => {
				throw new Error("credential fragment from upstream");
			},
		});
		expect(result).toMatchObject({ status: "error", error: "Usage request failed" });
		expect(JSON.stringify(result)).not.toContain("credential fragment");
	});
});
