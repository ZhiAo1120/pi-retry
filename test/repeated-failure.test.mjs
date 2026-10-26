import assert from "node:assert/strict";
import { test } from "node:test";
import registerRetry from "../index.ts";

const model = { provider: "test", id: "model" };
const failure = (errorMessage = "Unknown error (no error details in response)", stopReason = "error") => ({
	type: "message", id: crypto.randomUUID(), message: {
		role: "assistant", provider: model.provider, model: model.id,
		stopReason, errorMessage, content: [],
	},
});
const user = () => ({ type: "message", id: crypto.randomUUID(), message: { role: "user", content: "do the task" } });

function harness(branch, selectedModel = model) {
	const sent = [];
	const notices = [];
	const events = new Map();
	let handler;
	let aborts = 0;
	registerRetry({
		on(name, callback) { events.set(name, callback); },
		registerCommand(_name, command) { handler = command.handler; },
		sendMessage(message, options) {
			sent.push({ message, options });
			branch.push({ type: "custom_message", id: crypto.randomUUID(), ...message });
		},
	});
	const ctx = {
		hasUI: true, isIdle: () => true, model: selectedModel,
		ui: { notify(message, level) { notices.push({ message, level }); } },
		sessionManager: { getBranch: () => branch },
		abort() { aborts++; },
	};
	return {
		sent, notices, ctx,
		get aborts() { return aborts; },
		run: (args = "") => handler(args, ctx),
		emit: (name, event = {}) => events.get(name)?.(event, ctx),
	};
}

test("the same failure after manual retry is blocked, including after reloading", async () => {
	const branch = [user(), failure()];
	const first = harness(branch);
	await first.run();
	assert.equal(first.sent.length, 1);
	branch.push(failure());
	const reloaded = harness(branch);
	await reloaded.run();
	assert.equal(reloaded.sent.length, 0);
	assert.match(reloaded.notices.at(-1).message, /same failure/i);
	assert.match(reloaded.notices.at(-1).message, /\/retry --force/);
});

test("legacy retry markers without details also prevent repeated failures", async () => {
	const h = harness([user(), failure(), { type: "custom_message", customType: "manual-retry" }, failure()]);
	await h.run();
	assert.equal(h.sent.length, 0);
});

test("request and trace IDs do not disguise the same provider error", async () => {
	const branch = [user(), failure("400 invalid_request_error [trace_id=abc123]")];
	const h = harness(branch);
	await h.run();
	branch.push(failure("400 invalid_request_error [trace_id=def456]"));
	await h.run();
	assert.equal(h.sent.length, 1);
});

test("diagnostic output does not reset the repeated-failure guard", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();
	branch.push(failure(), { type: "message", message: { role: "bashExecution", exitCode: 0 } });
	await h.run();
	assert.equal(h.sent.length, 1);
});

test("changing model, a new user request, or successful tool progress permits a new retry", async () => {
	for (const change of [
		(h) => { h.ctx.model = { provider: "other", id: "model" }; },
		(_h, branch) => branch.push(user(), failure()),
		(_h, branch) => branch.push({ type: "message", message: { role: "toolResult", isError: false } }, failure()),
	]) {
		const branch = [user(), failure()];
		const h = harness(branch);
		await h.run();
		branch.push(failure());
		change(h, branch);
		await h.run();
		assert.equal(h.sent.length, 2);
	}
});

test("a different error permits another attempt", async () => {
	const branch = [user(), failure("503 overloaded")];
	const h = harness(branch);
	await h.run();
	branch.push(failure("401 invalid API key"));
	await h.run();
	assert.equal(h.sent.length, 2);
});

test("--force permits a new bounded attempt after correcting an external problem", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();
	branch.push(failure());
	await h.run("--force");
	assert.equal(h.sent.length, 2);
	branch.push(failure());
	await h.emit("agent_end", { messages: [branch.at(-1).message] });
	assert.equal(h.aborts, 1, "force must not disable the in-run circuit breaker");
});

test("an unfinished dispatch is not duplicated even if the host still reports idle", async () => {
	const h = harness([user(), failure()]);
	await h.run();
	await h.run();
	assert.equal(h.sent.length, 1);
});

test("user cancellation does not count as a repeated provider failure", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();
	branch.push(failure("Operation aborted", "aborted"));
	await h.run();
	assert.equal(h.sent.length, 2);
});

test("the first repeated provider failure stops native retries without rewriting the error", async () => {
	const branch = [user(), failure("429 token rate limit")];
	const h = harness(branch);
	await h.run();
	branch.push(failure("429 token rate limit"));
	const error = branch.at(-1).message;
	const original = structuredClone(error);
	await h.emit("agent_end", { messages: [error] });
	assert.equal(h.aborts, 1);
	assert.deepEqual(error, original);
	assert.match(h.notices.at(-1).message, /quota|rate limit/i);
});

test("varying provider errors still stop after three failed requests in a manual attempt", async () => {
	const branch = [user(), failure("503 initial failure")];
	const h = harness(branch);
	await h.run();
	for (let attempt = 1; attempt <= 3; attempt++) {
		branch.push(failure(`503 failure ${attempt}`));
		await h.emit("agent_end", { messages: [branch.at(-1).message] });
		assert.equal(h.aborts, attempt === 3 ? 1 : 0);
	}
	const reloaded = harness(branch);
	await reloaded.run();
	assert.equal(reloaded.sent.length, 0);
	assert.match(reloaded.notices.at(-1).message, /budget|three|3/i);
});

test("the circuit breaker does not affect runs not started by /retry or later settled runs", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	branch.push(failure());
	await h.emit("agent_end", { messages: [branch.at(-1).message] });
	assert.equal(h.aborts, 0);
	await h.run();
	await h.emit("agent_settled");
	branch.push(failure());
	await h.emit("agent_end", { messages: [branch.at(-1).message] });
	assert.equal(h.aborts, 0);
});

test("switching the selected model mid-run cannot bypass the active request budget", async () => {
	const branch = [user(), failure("503 original")];
	const h = harness(branch);
	await h.run();
	h.ctx.model = { provider: "other", id: "model" };
	for (let attempt = 1; attempt <= 3; attempt++) {
		branch.push(failure(`503 changing error ${attempt}`));
		await h.emit("agent_end", { messages: [branch.at(-1).message] });
	}
	assert.equal(h.aborts, 1);
});

test("tool failure identity ignores call IDs and argument key order but respects changed arguments", async () => {
	const batch = (arguments_) => {
		const id = crypto.randomUUID();
		return [
			{ type: "message", id: crypto.randomUUID(), message: {
				role: "assistant", stopReason: "toolUse", provider: model.provider, model: model.id,
				content: [{ type: "toolCall", id, name: "bash", arguments: arguments_ }],
			} },
			{ type: "message", id: crypto.randomUUID(), message: {
				role: "toolResult", toolName: "bash", toolCallId: id, isError: true,
				content: [{ type: "text", text: "permission denied" }],
			} },
		];
	};
	for (const changed of [false, true]) {
		const branch = [user(), ...batch({ command: "test", timeout: 10 })];
		const h = harness(branch);
		await h.run();
		branch.push(...batch({ timeout: 10, command: changed ? "different" : "test" }));
		await h.run();
		assert.equal(h.sent.length, changed ? 2 : 1);
	}
});

test("only hashes and model identity are persisted in retry details, not raw error secrets", async () => {
	const h = harness([user(), failure("401 invalid API key: PRIVATE_TEST_VALUE")]);
	await h.run();
	const details = h.sent[0].message.details;
	assert.match(details.fingerprint, /^[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(details).includes("PRIVATE_TEST_VALUE"), false);
});

