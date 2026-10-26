import { createHash } from "node:crypto";
import type { ExtensionAPI, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { isResourceAttributionError, sanitizePayload, type SanitizeMode } from "./sanitize.ts";

const MAX_FAILED_REQUESTS = 3;

/** Repair armed for the run a manual retry started, plus what it has removed so far. */
type Repair = { mode: SanitizeMode; removedIds: number; removedReasoning: number };

type Checkpoint = {
	index: number;
	entries: SessionMessageEntry[];
	fingerprint?: string;
	model?: string;
};
type RetryBlock = "pending" | "repeat" | "budget";

function normalizeError(text: string): string {
	return text.replace(/\b(?:request|trace)[_ -]?id["']?\s*[:=]\s*["']?[\w.-]+/gi, "request-id=<omitted>")
		.replace(/\s+/g, " ").trim();
}

function checkpoint(entries: SessionMessageEntry[], index: number, assistant?: SessionMessageEntry): Checkpoint {
	const message = assistant?.message;
	const model = message?.role === "assistant" ? `${message.provider}/${message.model}` : undefined;
	const errors = entries.flatMap(({ message: failure }) => {
		if (failure.role === "assistant" && failure.stopReason === "error") {
			return [[failure.role, failure.provider, failure.model, normalizeError(failure.errorMessage ?? "Unknown error")]];
		}
		if (failure.role === "toolResult") {
			const call = message?.role === "assistant"
				? message.content.find(part => part.type === "toolCall" && part.id === failure.toolCallId)
				: undefined;
			return [[failure.role, failure.toolName, call?.type === "toolCall" ? call.arguments : null,
				normalizeError(failure.content.filter(part => part.type === "text").map(part => part.text).join("\n"))]];
		}
		return [];
	});
	// Store hashes, never a second copy of provider errors, credentials or tool arguments.
	const serialized = errors.map(error => JSON.stringify(error, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).sort();
	return { index, entries, model, fingerprint: errors.length ? createHash("sha256").update(JSON.stringify(serialized)).digest("hex") : undefined };
}

/** Inspect only the latest assistant response and its following tool batch. */
function failedCheckpoint(branch: readonly SessionEntry[]): Checkpoint | undefined {
	const failedTools: SessionMessageEntry[] = [];
	let lastIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.isError) {
			if (lastIndex < 0) lastIndex = i;
			failedTools.push(entry);
		} else if (message.role === "assistant") {
			if (failedTools.length) return checkpoint(failedTools, lastIndex, entry);
			if (message.stopReason === "error" || message.stopReason === "aborted") return checkpoint([entry], i, entry);
			return undefined;
		} else if (message.role === "user") {
			break;
		}
		// Diagnostic shell output, system messages and metadata do not end a turn.
	}
	return failedTools.length ? checkpoint(failedTools, lastIndex) : undefined;
}

/** Reconstruct the latest manual attempt from the active branch, including legacy markers. */
function retryBlock(branch: readonly SessionEntry[], failure: Checkpoint, model: string | undefined): RetryBlock | undefined {
	const errors: string[] = [];
	let progressed = false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom_message" && entry.customType === "manual-retry") {
			if (failure.index < i) return "pending";
			if (!failure.fingerprint) return undefined; // User cancellation is not a provider failure.
			const details = entry.details;
			const recorded = details && typeof details === "object" && "version" in details && details.version === 1
				&& "fingerprint" in details && typeof details.fingerprint === "string"
				&& "model" in details && typeof details.model === "string" ? details : undefined;
			const previous = recorded ? undefined : failedCheckpoint(branch.slice(0, i));
			const previousModel = recorded?.model ?? previous?.model;
			if (model && previousModel && model !== previousModel) return undefined;
			if (errors.length >= MAX_FAILED_REQUESTS) return "budget";
			if (new Set(errors).size < errors.length) return "repeat";
			if (!progressed && failure.fingerprint === (recorded?.fingerprint ?? previous?.fingerprint)) return "repeat";
			return undefined;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") return undefined;
		if (message.role === "toolResult" && !message.isError) progressed = true;
		if (message.role === "assistant") {
			if (message.stopReason === "error" && !progressed) errors.push(checkpoint([entry], i, entry).fingerprint!);
			else if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "toolUse") return undefined;
		}
	}
	return undefined;
}

function blockMessage(reason: RetryBlock, failure: Checkpoint): string {
	const prefix = reason === "pending" ? "A retry was already requested for this checkpoint."
		: reason === "budget" ? `Retry stopped after ${MAX_FAILED_REQUESTS} failed provider requests without progress.`
			: "Retry stopped: the same failure occurred again without progress.";
	const error = failure.entries.map(entry => entry.message.role === "assistant" ? entry.message.errorMessage ?? "" : "").join(" ");
	if (isResourceAttributionError(error)) {
		return `${prefix} The upstream rejected history minted by another resource. /retry --deep drops historical reasoning items so this turn can continue without them.`;
	}
	const hint = /rate.?limit|429|quota|billing/i.test(error) ? "Wait for the rate limit or quota to reset, or select another provider."
		: /different.*resource|invalid_request|\b400\b/i.test(error) ? "Check the request and provider routing; retrying unchanged input cannot repair it."
			: /\b40[13]\b|api.?key|authentication/i.test(error) ? "Check provider credentials and permissions."
				: "Inspect the failed operation and provider/network configuration before trying again.";
	return `${prefix} ${hint} After correcting the cause, use /retry --force for one new bounded attempt.`;
}

export default function registerManualRetry(pi: ExtensionAPI): void {
	let manualRun = false;
	let repair: Repair | undefined;
	// Survives disarming so a failed run can still report what it repaired.
	let settled: Repair | undefined;
	const disarm = () => { manualRun = false; settled = repair; repair = undefined; };
	pi.on("agent_settled", (_event, ctx) => {
		const done = repair ?? settled;
		settled = undefined;
		if (done && (done.removedIds || done.removedReasoning) && ctx.hasUI) {
			const parts = [
				done.removedIds ? `${done.removedIds} history item id(s)` : "",
				done.removedReasoning ? `${done.removedReasoning} reasoning item(s)` : "",
			].filter(Boolean);
			ctx.ui.notify(`Retry repaired the request: removed ${parts.join(" and ")}.`, "info");
		}
		disarm();
	});
	pi.on("session_start", () => { settled = undefined; disarm(); });
	pi.on("session_shutdown", () => { settled = undefined; disarm(); });
	// Repair only the run a manual retry started, so ordinary requests keep their exact
	// history, reasoning items and prompt cache prefix.
	pi.on("before_provider_request", (event, ctx) => {
		if (!repair || !ctx.model?.api.includes("responses")) return undefined;
		const result = sanitizePayload(event.payload, repair.mode);
		if (!result) return undefined;
		repair.removedIds += result.removedIds;
		repair.removedReasoning += result.removedReasoning;
		return result.payload;
	});
	pi.on("agent_end", (event, ctx) => {
		if (!manualRun) return;
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		if (last?.role !== "assistant" || last.stopReason !== "error") return;
		const branch = ctx.sessionManager.getBranch();
		const failure = failedCheckpoint(branch);
		if (!failure) return;
		// A model change permits a new command, but cannot disable the budget of
		// a manual run already in flight.
		const reason = retryBlock(branch, failure, undefined);
		if (!reason) return;
		disarm();
		// agent_end precedes Pi's native retry scheduler. Abort without awaiting idle
		// inside the event handler; preserve the original error and all session entries.
		ctx.abort();
		if (ctx.hasUI) ctx.ui.notify(blockMessage(reason, failure), "warning");
	});

	pi.registerCommand("retry", {
		description: "Resume a failed turn without rewinding; --force ignores the repeat guard, --deep also drops historical reasoning",
		handler: async (args, ctx) => {
			const flags = args.trim() ? args.trim().split(/\s+/) : [];
			const force = flags.includes("--force");
			const deep = flags.includes("--deep");
			if (flags.some(flag => flag !== "--force" && flag !== "--deep")) {
				ctx.ui.notify("Usage: /retry [--force] [--deep]", "warning");
				return;
			}
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before using /retry.", "warning");
				return;
			}
			const branch = ctx.sessionManager.getBranch();
			const failure = failedCheckpoint(branch);
			if (!failure) {
				ctx.ui.notify("Nothing to retry. /retry only resumes a failed or interrupted turn.", "info");
				return;
			}
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : failure.model;
			const reason = retryBlock(branch, failure, model);
			if (reason && !force) {
				ctx.ui.notify(blockMessage(reason, failure), "warning");
				return;
			}

			// Keep the checkpoint: rewinding would hide already-completed side effects.
			manualRun = true;
			settled = undefined;
			repair = { mode: deep ? "ids_and_reasoning" : "ids", removedIds: 0, removedReasoning: 0 };
			try {
				pi.sendMessage({
					customType: "manual-retry",
					content: "The previous turn failed or was interrupted. Continue from the current checkpoint by retrying only the failed or unfinished operation. Inspect the current state for partial side effects before retrying an operation. Do not repeat successful tool calls or redo completed side effects. If the same operation fails again, stop and explain the cause and corrective action instead of repeating it unchanged.",
					display: false,
					details: { version: 1, fingerprint: failure.fingerprint ?? "", model: model ?? "" },
				}, { triggerTurn: true });
				ctx.ui.notify(
					deep
						? "Resuming from the failed checkpoint; historical reasoning is dropped for this attempt."
						: "Resuming from the failed checkpoint with repeated-failure protection.",
					"info",
				);
			} catch (error) {
				disarm();
				throw error;
			}
		},
	});
}
