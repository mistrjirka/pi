/** Defer huge, persisted tool-result snapshots until code that needs them accesses state.
 * Store only the byte offset of the JSON string. The on-disk JSONL file is
 * authoritative and is not rewritten to remove content.
 */
import { closeSync, openSync, readSync } from "node:fs";

const MIN_DEFERRED_STATE_BYTES = 256 * 1024;
export interface DeferredState {
	path: string;
	offset: number;
	length: number;
	override?: string;
}
const deferredStateByDetails = new WeakMap<object, DeferredState>();

export function deferredStateForDetails(details: object): DeferredState | undefined {
	return deferredStateByDetails.get(details);
}

export interface JSONStringRange {
	readonly start: number;
	readonly end: number;
}

/** Locate the value of details.state without examining parsed tool contents. */
export function largeDetailsStateRange(line: string, minBytes = MIN_DEFERRED_STATE_BYTES): JSONStringRange | undefined {
	if (line.length < minBytes || !line.includes('"details"')) return undefined;
	const detailsIndex = line.indexOf('"details"');
	const stateKeyIndex = line.indexOf('"state"', detailsIndex + 9);
	if (stateKeyIndex < 0) return undefined;
	let opening = stateKeyIndex + '"state"'.length;
	while (line[opening] === " " || line[opening] === "\t") opening++;
	if (line[opening] !== ":") return undefined;
	opening++;
	while (line[opening] === " " || line[opening] === "\t") opening++;
	if (line[opening] !== '"') return undefined;

	let closing = opening + 1;
	while (true) {
		closing = line.indexOf('"', closing);
		if (closing < 0) return undefined;
		let backslashes = 0;
		for (let i = closing - 1; i > opening && line[i] === "\\"; i--) backslashes++;
		if ((backslashes & 1) === 0) break;
		closing++;
	}
	if (closing - opening < minBytes) return undefined;
	return { start: opening, end: closing + 1 };
}

function readDeferredState(ref: DeferredState): string {
	if (ref.override !== undefined) return ref.override;
	const fd = openSync(ref.path, "r");
	try {
		const buffer = Buffer.allocUnsafe(ref.length);
		let total = 0;
		while (total < buffer.length) {
			const count = readSync(fd, buffer, total, buffer.length - total, ref.offset + total);
			if (count === 0) throw new Error("Session state snapshot was truncated or replaced.");
			total += count;
		}
		const value: unknown = JSON.parse(buffer.toString("utf8"));
		if (typeof value !== "string") throw new Error("Session state snapshot is not a string.");
		return value;
	} finally {
		closeSync(fd);
	}
}

/** Parsed session entries are a disk trust boundary, including deferred completion records. */
function toolResultFromEntry(entry: object): Record<string, unknown> | undefined {
	const record = entry as Record<string, unknown>;
	const result =
		record.type === "tool_completion" ? record.result : record.type === "message" ? record.message : undefined;
	if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
	const value = result as Record<string, unknown>;
	return record.type === "tool_completion" || value.role === "toolResult" ? value : undefined;
}

/**
 * Offload new large tool-result snapshots after the entry has been durably
 * appended. The entry is shared with the live agent history, so replacing the
 * property on the original details object releases the snapshot in both places.
 * Failed optimization must not undo a successful append.
 */
export function deferAppendedSessionState(entry: object, path: string, lineOffset: number): void {
	const record = entry as Record<string, unknown>;
	const result = toolResultFromEntry(entry);
	if (!result || (record.type === "tool_completion" ? record.toolName : result.toolName) !== "code") return;
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return;
	const typed = details as { state?: unknown };
	if (typeof typed.state !== "string" || typed.state.length < MIN_DEFERRED_STATE_BYTES) return;
	try {
		const text = JSON.stringify(entry);
		const range = largeDetailsStateRange(text);
		if (!range) return;
		const reference: DeferredState = {
			path,
			offset: lineOffset + Buffer.byteLength(text.slice(0, range.start)),
			length: Buffer.byteLength(text.slice(range.start, range.end)),
		};
		installDeferredStateGetter(details, reference);
	} catch {
		// The entry is already persisted. Keep the in-memory state if optimization
		// fails rather than throwing after a successful disk write.
	}
}

function installDeferredStateGetter(details: object, reference: DeferredState): void {
	Object.defineProperty(details, "state", {
		configurable: true,
		enumerable: true,
		get: () => readDeferredState(reference),
		set: (next: string) => {
			reference.override = next;
		},
	});
	deferredStateByDetails.set(details, reference);
}

/** Preserve the full entry contract while keeping a large state off-heap. */
export function parseDeferredSessionEntry<T>(line: string, filePath: string, byteOffset: number): T | null {
	const range = largeDetailsStateRange(line);
	if (!range) {
		try {
			return JSON.parse(line) as T;
		} catch {
			return null;
		}
	}
	let parsed: T;
	try {
		parsed = JSON.parse(`${line.slice(0, range.start)}""${line.slice(range.end)}`) as T;
	} catch {
		try {
			return JSON.parse(line) as T;
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object") return parsed;
	const result = toolResultFromEntry(parsed);
	const details = result?.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		try {
			return JSON.parse(line) as T;
		} catch {
			return null;
		}
	}
	const typedDetails = details as Record<string, unknown>;
	if (typedDetails.state !== "") {
		try {
			return JSON.parse(line) as T;
		} catch {
			return null;
		}
	}
	const reference: DeferredState = {
		path: filePath,
		offset: byteOffset + Buffer.byteLength(line.slice(0, range.start)),
		length: Buffer.byteLength(line.slice(range.start, range.end)),
	};
	installDeferredStateGetter(typedDetails, reference);
	return parsed;
}
