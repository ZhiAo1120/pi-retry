import assert from "node:assert/strict";
import { test } from "node:test";

import registerRetry from "../index.ts";

const responsesModel = { provider: "test", id: "model", api: "openai-responses" };
const completionsModel = { provider: "test", id: "model", api: "openai-completions" };

const failure = (errorMessage = "Unknown error (no error details in response)") => ({
	type: "message", id: crypto.randomUUID(), message: {
		role: "assistant", provider: responsesModel.provider, model: responsesModel.id,
		stopReason: "error", errorMessage, content: [],
	},
});
const user = () => ({ type: "message", id: crypto.randomUUID(), message: { role: "user", content: "do the task" } });

const payload = () => ({
	model: "m",
	stream: true,
	input: [
		{ type: "message", role: "user", id: "msg_1", content: [{ type: "input_text", text: "go" }] },
		{ type: "reasoning", id: "rs_1", encrypted_content: "SECRET", summary: [] },
		{ type: "message", role: "assistant", id: "msg_2", status: "completed", content: [{ type: "output_text", text: "ok" }] },
	],
});

function harness(branch, selectedModel = responsesModel) {
	const sent = [];
	const notices = [];
	const events = new Map();
	let handler;
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
		abort() {},
	};
	return {
		sent, notices, ctx,
		run: (args = "") => handler(args, ctx),
		emit: (name, event = {}) => events.get(name)?.(event, ctx),
	};
}

test("ordinary requests are never repaired", async () => {
	const h = harness([user(), failure()]);
	const original = payload();
	assert.equal(await h.emit("before_provider_request", { payload: original }), undefined);
	assert.deepEqual(original.input[0], payload().input[0]);
});

test("a manual retry repairs only its own run, then disarms", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();

	const repaired = await h.emit("before_provider_request", { payload: payload() });
	assert.equal(repaired.input.length, 3, "reasoning survives the default mode");
	assert.equal("id" in repaired.input[0], false);
	assert.deepEqual(repaired.input[1], { type: "reasoning", id: "rs_1", encrypted_content: "SECRET", summary: [] });

	await h.emit("agent_settled");
	assert.equal(await h.emit("before_provider_request", { payload: payload() }), undefined);
});

test("--deep drops historical reasoning for that attempt only", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run("--deep");

	const repaired = await h.emit("before_provider_request", { payload: payload() });
	assert.equal(repaired.input.length, 2);
	assert.equal(repaired.input.some(item => item.type === "reasoning"), false);
	assert.match(h.notices.at(-1).message, /historical reasoning is dropped/i);

	await h.emit("agent_settled");
	assert.equal(await h.emit("before_provider_request", { payload: payload() }), undefined);
});

test("chat-completions payloads are never touched", async () => {
	const branch = [user(), failure()];
	const h = harness(branch, completionsModel);
	await h.run();
	assert.equal(await h.emit("before_provider_request", { payload: payload() }), undefined);
});

test("a failed dispatch disarms the repair", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	h.sent.length = 0;
	const throwing = { ...h.ctx };
	throwing.sessionManager = { getBranch: () => branch };
	// sendMessage throws only on the dispatch path, after the repair was armed.
	registerRetry({
		on() {},
		registerCommand(_name, command) { throwing.run = (args) => command.handler(args, throwing); },
		sendMessage() { throw new Error("host rejected the message"); },
	});
	await assert.rejects(() => throwing.run(""), /host rejected/);
	const events = new Map();
	registerRetry({ on(name, cb) { events.set(name, cb); }, registerCommand() {}, sendMessage() {} });
	assert.equal(await events.get("before_provider_request")?.({ payload: payload() }, throwing), undefined);
});

test("the repair reports what it removed once the run settles", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();
	await h.emit("before_provider_request", { payload: payload() });
	await h.emit("agent_settled");
	const summary = h.notices.findLast(n => /repaired the request/i.test(n.message));
	assert.match(summary.message, /2 history item id\(s\)/);
});

test("a repaired run that fails still reports the repair", async () => {
	const branch = [user(), failure()];
	const h = harness(branch);
	await h.run();
	await h.emit("before_provider_request", { payload: payload() });
	// agent_end disarms the repair before the run settles.
	branch.push(failure("503 still failing"));
	await h.emit("agent_end", { messages: [branch.at(-1).message] });
	await h.emit("agent_settled");
	assert.match(h.notices.findLast(n => /repaired the request/i.test(n.message)).message, /2 history item id\(s\)/);
});

test("a resource attribution failure names the deep repair instead of generic advice", async () => {
	const branch = [user(), failure(
		"Invalid request: Item with id 'msg_1' was created under a different Azure OpenAI resource and cannot be used. Please use the same resource for all requests.",
	)];
	const h = harness(branch);
	await h.run();
	branch.push(failure(
		"Invalid request: Item with id 'msg_1' was created under a different Azure OpenAI resource and cannot be used. Please use the same resource for all requests.",
	));
	await h.run();
	const last = h.notices.at(-1).message;
	assert.match(last, /--deep/);
	assert.doesNotMatch(last, /Check the request and provider routing/);
});
