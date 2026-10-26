/**
 * Payload repair for Responses API history that the upstream can no longer replay.
 *
 * A pooled upstream may answer with a different resource than the one that minted the
 * previous history items, so their `id` values no longer resolve. Stripping the optional
 * ids keeps every message body, tool pair and reasoning item intact; dropping reasoning
 * items is a separate, lossy mode that the caller must ask for.
 */

export type SanitizeMode = "ids" | "ids_and_reasoning";

export interface SanitizeResult {
	payload: Record<string, unknown>;
	removedIds: number;
	removedReasoning: number;
}

const REPLAYABLE_ROLES = new Set(["user", "assistant", "system", "developer"]);

/** Two substrings that both appear in the resource-attribution rejection. */
const RESOURCE_MISMATCH = ["created under a different azure openai resource", "use the same resource"];

function nonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function stringOrArray(value: unknown): boolean {
	return typeof value === "string" || Array.isArray(value);
}

/**
 * A history item whose payload alone carries its meaning: dropping its id leaves a
 * complete, replayable item. Partial or streaming items keep their id because the
 * upstream may still need to resolve them.
 */
function isCompleteReplayable(item: Record<string, unknown>): boolean {
	const kind = typeof item.type === "string" ? item.type : "message";
	switch (kind) {
		case "message":
			return REPLAYABLE_ROLES.has(item.role as string) && stringOrArray(item.content);
		case "function_call":
			return nonEmptyString(item.call_id) && nonEmptyString(item.name) && typeof item.arguments === "string";
		case "custom_tool_call":
			return nonEmptyString(item.call_id) && nonEmptyString(item.name) && typeof item.input === "string";
		case "function_call_output":
		case "custom_tool_call_output":
			return nonEmptyString(item.call_id) && stringOrArray(item.output);
		default:
			return false;
	}
}

/**
 * Returns a repaired payload, or undefined when nothing had to change.
 *
 * Only the direct `id` of complete items is removed. `call_id`, `content`,
 * `encrypted_content`, `type` and every other field are preserved, as are array order,
 * item count and non-object entries. Payloads without an `input` array (chat
 * completions) are left alone.
 */
export function sanitizePayload(payload: unknown, mode: SanitizeMode): SanitizeResult | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	const input = body.input;
	if (!Array.isArray(input)) return undefined;

	let removedIds = 0;
	let removedReasoning = 0;
	const kept: unknown[] = [];
	for (const entry of input) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			kept.push(entry);
			continue;
		}
		const item = entry as Record<string, unknown>;
		if (item.type === "reasoning") {
			if (mode !== "ids_and_reasoning") {
				kept.push(entry);
				continue;
			}
			removedReasoning++;
			continue;
		}
		if (!nonEmptyString(item.id) || (item.status !== undefined && item.status !== "completed") || !isCompleteReplayable(item)) {
			kept.push(entry);
			continue;
		}
		const { id: _omitted, ...rest } = item;
		kept.push(rest);
		removedIds++;
	}

	if (removedIds === 0 && removedReasoning === 0) return undefined;
	return { payload: { ...body, input: kept }, removedIds, removedReasoning };
}

/** Recognizes the exact upstream rejection that a history repair can actually fix. */
export function isResourceAttributionError(message: string): boolean {
	const normalized = message.replace(/\s+/g, " ").toLowerCase();
	return RESOURCE_MISMATCH.every((part) => normalized.includes(part));
}
