/**
 * Best-effort manual /retry for Pi.
 *
 * When the current branch ends with a failed tool result, keep that checkpoint
 * and inject a hidden continuation instruction so the model can retry only the
 * failed operation. Provider-level failures fall back to rewinding to the last
 * user request and resubmitting it because Pi does not expose OMP's internal
 * session.retry() or generic tool-batch executor to extensions.
 */

type UserContent =
	| string
	| Array<{
			type: "text" | "image";
			[key: string]: unknown;
		}>;

type BranchEntry = {
	id?: string;
	type?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		stopReason?: string;
		errorMessage?: unknown;
		isError?: boolean;
	};
};

type RetryContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
	isIdle(): boolean;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean },
	): Promise<{ cancelled: boolean }>;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sessionManager: {
		getBranch(): readonly BranchEntry[];
	};
};

type RetryPi = {
	registerCommand(
		name: string,
		options: {
			description: string;
			handler(args: string, ctx: RetryContext): Promise<void>;
		},
	): void;
	sendUserMessage(content: UserContent): Promise<void>;
};

function isUserContent(value: unknown): value is UserContent {
	if (typeof value === "string") return true;
	if (!Array.isArray(value)) return false;
	return value.every((part) => {
		if (!part || typeof part !== "object") return false;
		const type = (part as { type?: unknown }).type;
		return type === "text" || type === "image";
	});
}

function isFailedToolTail(entries: readonly BranchEntry[], afterIndex: number): boolean {
	const messages = entries
		.slice(afterIndex + 1)
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => entry.message!);
	const last = messages.at(-1);
	if (!last) return false;
	if (last.role === "toolResult" && last.isError === true) return true;
	if (last.role !== "assistant" || (last.stopReason !== "error" && last.stopReason !== "aborted")) {
		return false;
	}
	return messages
		.slice(0, -1)
		.some((message) => message.role === "toolResult" && message.isError === true);
}

function isFailedTurn(message: BranchEntry["message"]): boolean {
	if (!message) return false;
	if (message.role === "toolResult" && message.isError === true) return true;
	if (message.role !== "assistant") return false;
	return (
		message.stopReason === "error" ||
		message.stopReason === "aborted" ||
		(typeof message.errorMessage === "string" && message.errorMessage.length > 0)
	);
}

export default function registerManualRetry(pi: RetryPi): void {
	pi.registerCommand("retry", {
		description: "Retry the last failed or interrupted agent turn",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /retry", "warning");
				return;
			}
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current response to finish before using /retry.",
					"warning",
				);
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			let lastUserIndex = -1;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message?.role === "user") {
					lastUserIndex = i;
					break;
				}
			}

			if (lastUserIndex === -1) {
				ctx.ui.notify("Nothing to retry.", "info");
				return;
			}

			const userEntry = branch[lastUserIndex];
			const userMessage = userEntry?.message?.content;
			const failedToolTail = isFailedToolTail(branch, lastUserIndex);
			const failedAfterUser = branch
				.slice(lastUserIndex + 1)
				.some((entry) => entry.type === "message" && isFailedTurn(entry.message));
			if (
				!userEntry?.id ||
				!failedAfterUser ||
				!isUserContent(userMessage)
			) {
				ctx.ui.notify(
					"Nothing to retry. /retry only replays a failed or interrupted turn.",
					"info",
				);
				return;
			}

			if (failedToolTail) {
				// Keep the current tool-result checkpoint. The hidden continuation tells
				// the model to retry only the failed operation, avoiding a rewind that
				// could repeat successful tool side effects. This is the closest public
				// API equivalent to OMP's direct tool-batch replay.
				ctx.ui.notify("Retrying from the failed tool checkpoint.", "info");
				pi.sendMessage(
					{
						customType: "manual-retry",
						content:
							"The previous tool call failed or was interrupted. Continue from the current checkpoint by retrying only the failed tool call. Do not repeat successful tool calls or redo completed side effects.",
						display: false,
					},
					{ triggerTurn: true },
				);
				return;
			}

			const navigation = await ctx.navigateTree(userEntry.id, { summarize: false });
			if (navigation.cancelled) {
				ctx.ui.notify("Retry cancelled.", "warning");
				return;
			}

			ctx.ui.notify("Retrying the last failed turn.", "info");
			await pi.sendUserMessage(userMessage);
		},
	});
}
