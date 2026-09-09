import assert from "node:assert/strict";

import registerManualRetry from "../index.ts";

const commands = new Map();
const sentUsers = [];
const sentCustom = [];

registerManualRetry({
	registerCommand(name, options) {
		commands.set(name, options.handler);
	},
	async sendUserMessage(content) {
		sentUsers.push(content);
	},
	sendMessage(message, options) {
		sentCustom.push({ message, options });
	},
});

assert.equal(commands.size, 1);
assert.ok(commands.has("retry"));

const notices = [];
function context(branch, cancelled = false) {
	return {
		hasUI: true,
		ui: { notify(message) { notices.push(message); } },
		isIdle: () => true,
		navigateTree: async (id) => {
			notices.push(`navigate:${id}`);
			return { cancelled };
		},
		sessionManager: { getBranch: () => branch },
	};
}

await commands.get("retry")("", context([
	{ id: "u1", type: "message", message: { role: "user", content: "implement it" } },
	{
		id: "a1",
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "tc1", name: "write" }],
		},
	},
	{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "tc1", isError: true } },
]));
assert.equal(sentUsers.length, 0);
assert.equal(sentCustom.length, 1);
assert.equal(sentCustom[0].options.triggerTurn, true);
assert.match(sentCustom[0].message.content, /only the failed tool call/);

const beforeUsers = sentUsers.length;
await commands.get("retry")("", context([
	{ id: "u2", type: "message", message: { role: "user", content: "try provider" } },
	{ id: "a2", type: "message", message: { role: "assistant", stopReason: "error" } },
]));
assert.equal(sentUsers.length, beforeUsers + 1);
assert.equal(sentUsers.at(-1), "try provider");
assert.ok(notices.includes("navigate:u2"));

const beforeRetry = sentUsers.length + sentCustom.length;
await commands.get("retry")("", context([
	{ id: "u3", type: "message", message: { role: "user", content: "already done" } },
	{ id: "a3", type: "message", message: { role: "assistant", stopReason: "stop" } },
]));
assert.equal(sentUsers.length + sentCustom.length, beforeRetry);

console.log("manual-retry tests: PASS");
