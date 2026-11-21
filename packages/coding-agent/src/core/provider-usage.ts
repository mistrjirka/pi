/** Account-bound subscription usage. Reading it never starts a model turn. */
export interface ProviderUsageLimit {
	kind: string;
	label: string;
	percent: number | null;
	resetAt: number | null;
	scope?: string;
	active?: boolean;
	severity?: "normal" | "warning" | "critical";
}

export interface ProviderUsageSnapshot {
	provider: string;
	status: "ok" | "stale" | "unavailable" | "error";
	accountId?: string;
	accountLabel?: string;
	profileSource?: string;
	configDir?: string;
	observedAt: number | null;
	limits: ProviderUsageLimit[];
	source: string;
	error?: string;
}

export interface ProviderUsageRequest {
	provider: string;
	modelId: string;
	signal: AbortSignal;
}

/** Bound an optional usage read without interrupting the session's model or tools. */
export async function readProviderUsage(options: {
	provider: string;
	modelId: string;
	read: (request: ProviderUsageRequest) => Promise<ProviderUsageSnapshot | undefined>;
	isCurrent: () => boolean;
	timeoutMs?: number;
}): Promise<ProviderUsageSnapshot> {
	const unavailable: ProviderUsageSnapshot = {
		provider: options.provider,
		status: "unavailable",
		observedAt: null,
		limits: [],
		source: "provider",
	};
	const controller = new AbortController();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
			resolve(undefined);
		}, options.timeoutMs ?? 15_000);
	});
	try {
		const snapshot = await Promise.race([
			options.read({
				provider: options.provider,
				modelId: options.modelId,
				signal: controller.signal,
			}),
			timeout,
		]);
		if (!options.isCurrent()) return unavailable;
		if (timedOut) return { ...unavailable, status: "error", error: "Usage request timed out" };
		if (!snapshot) return unavailable;
		if (snapshot.provider !== options.provider) return unavailable;
		return snapshot;
	} catch {
		// Provider failures can contain authentication details. Keep them off the RPC wire.
		return {
			...unavailable,
			status: "error",
			error: timedOut ? "Usage request timed out" : "Usage request failed",
		};
	} finally {
		clearTimeout(timer);
	}
}
