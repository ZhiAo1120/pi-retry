import assert from "node:assert/strict";
import { test } from "node:test";

import registerManualRetry from "../index.ts";

const message = (role, fields = {}) => ({
	id: role,
	type: "message",
	message: { role, content: [], ...fields },
});
const user = message("user", { content: "implement it" });
const assistant = (stopReason, fields = {}) => message("assistant", { stopReason, ...fields });
const toolResult = (isError) => message("toolResult", { isError });

async function run(branch, { args = "", idle = true, hasUI = true } = {}) {
	const sent = [];
	const notices = [];
	const before = structuredClone(branch);
	let handler;
	registerManualRetry({
		on() {},
		registerCommand(name, command) {
			assert.equal(name, "retry");
			assert.equal(handler, undefined);
			handler = command.handler;
		},
		sendMessage(message, options) {
			sent.push({ message, options });
		},
		sendUserMessage() {
			assert.fail("/retry must not resubmit the user's request");
		},
	});
	assert.equal(typeof handler, "function");
	await handler(args, {
		hasUI,
		ui: { notify(message, level) { notices.push({ message, level }); } },
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch },
		navigateTree() {
			assert.fail("/retry must not rewind the session tree");
		},
	});
	assert.deepEqual(branch, before, "/retry must preserve the current branch");
	return { sent, notices };
}

test("provider failure resumes after successful side effects without replaying the request", async () => {
	const { sent } = await run([
		user,
		assistant("toolUse"),
		toolResult(false),
		assistant("error"),
	]);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "manual-retry");
	assert.equal(sent[0].message.display, false);
	assert.deepEqual(sent[0].options, { triggerTurn: true });
	assert.match(sent[0].message.content, /only the failed or unfinished operation/);
	assert.match(sent[0].message.content, /partial.*side effects/);
	assert.match(sent[0].message.content, /Do not repeat successful tool calls/);
});

test("an aborted assistant resumes from its checkpoint", async () => {
	assert.equal((await run([user, assistant("aborted")])).sent.length, 1);
});

test("extension-originated requests do not require a user-message ancestor", async () => {
	assert.equal((await run([
		{ type: "custom_message", customType: "request", content: "continue working" },
		assistant("error"),
	])).sent.length, 1);
});

test("a failed tool tail resumes", async () => {
	assert.equal((await run([user, assistant("toolUse"), toolResult(true)])).sent.length, 1);
});

test("a failed sibling in the latest tool batch is not hidden by a successful result", async () => {
	for (const errors of [[true, false], [false, true]]) {
		assert.equal((await run([
			user,
			assistant("toolUse"),
			...errors.map(toolResult),
		])).sent.length, 1);
	}
});

test("diagnostic shell output, system messages and metadata do not hide a failure", async () => {
	for (const tail of [
		message("bashExecution", { command: "git status --short", exitCode: 0 }),
		message("system", { content: "updated system instructions" }),
		{ type: "model_change" },
		{ type: "custom", customType: "status", data: {} },
	]) {
		assert.equal((await run([user, assistant("error"), tail])).sent.length, 1);
	}
});

test("a successful recovery is not retried despite older provider or tool failures", async () => {
	for (const failure of [assistant("error"), toolResult(true)]) {
		assert.deepEqual((await run([user, failure, assistant("stop")])).sent, []);
	}
});

test("a successful latest tool batch does not resurrect an older failed batch", async () => {
	assert.deepEqual((await run([
		user,
		assistant("toolUse"),
		toolResult(true),
		assistant("toolUse"),
		toolResult(false),
	])).sent, []);
});

test("a new user request is a boundary even with later diagnostic output", async () => {
	assert.deepEqual((await run([
		user,
		assistant("error"),
		message("user", { content: "a different request" }),
		message("bashExecution", { command: "git status --short", exitCode: 0 }),
	])).sent, []);
});

test("a successful stop reason takes precedence over stale error text", async () => {
	assert.deepEqual((await run([
		user,
		assistant("stop", { errorMessage: "old error" }),
	])).sent, []);
});

test("empty, successful and non-failure branches are not retried", async () => {
	for (const branch of [
		[],
		[user],
		[{ type: "model_change" }],
		[user, assistant("stop")],
		[user, assistant("length")],
		[user, assistant("deferred")],
	]) {
		const { sent, notices } = await run(branch);
		assert.deepEqual(sent, []);
		assert.match(notices[0].message, /Nothing to retry/);
	}
});

test("arguments are rejected", async () => {
	const { sent, notices } = await run([user, assistant("error")], { args: "extra" });
	assert.deepEqual(sent, []);
	assert.deepEqual(notices, [{ message: "Usage: /retry [--force] [--deep]", level: "warning" }]);
});

test("busy sessions are not retried", async () => {
	const { sent, notices } = await run([user, assistant("error")], { idle: false });
	assert.deepEqual(sent, []);
	assert.match(notices[0].message, /Wait for the current response/);
});

test("non-UI contexts are left unchanged", async () => {
	const { sent, notices } = await run([user, assistant("error")], { hasUI: false });
	assert.deepEqual(sent, []);
	assert.deepEqual(notices, []);
});
