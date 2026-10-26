import assert from "node:assert/strict";
import { test } from "node:test";

import { isResourceAttributionError, sanitizePayload } from "../sanitize.ts";

const history = () => [
	{ type: "message", role: "user", id: "msg_user_1", content: [{ type: "input_text", text: "do it" }] },
	{ type: "reasoning", id: "rs_1", encrypted_content: "SECRET", summary: [] },
	{ type: "message", role: "assistant", id: "msg_asst_1", status: "completed", content: [{ type: "output_text", text: "ok" }] },
	{ type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "{}" },
	{ type: "function_call_output", id: "fco_1", call_id: "call_1", output: "done" },
];

const body = () => ({ model: "m", stream: true, store: false, include: ["reasoning.encrypted_content"], input: history() });

test("ids mode drops only the direct id of complete items", () => {
	const result = sanitizePayload(body(), "ids");
	assert.equal(result?.removedIds, 4);
	assert.equal(result?.removedReasoning, 0);
	const input = result.payload.input;
	assert.equal(input.length, 5);
	for (const item of input) {
		// Reasoning items are not complete message/tool items; their id stays either way.
		assert.equal("id" in item, item.type === "reasoning");
	}
});

test("ids mode keeps reasoning, tool pairs and every other field", () => {
	const result = sanitizePayload(body(), "ids");
	const input = result.payload.input;
	assert.deepEqual(input[1], { type: "reasoning", id: "rs_1", encrypted_content: "SECRET", summary: [] });
	assert.equal(input[3].call_id, "call_1");
	assert.equal(input[4].call_id, "call_1");
	assert.equal(input[4].output, "done");
	assert.deepEqual(result.payload.include, ["reasoning.encrypted_content"]);
	assert.equal(result.payload.store, false);
});

test("ids_and_reasoning drops reasoning items as well", () => {
	const result = sanitizePayload(body(), "ids_and_reasoning");
	assert.equal(result?.removedReasoning, 1);
	assert.equal(result?.removedIds, 4);
	assert.equal(result.payload.input.length, 4);
	assert.equal(result.payload.input.some(item => item.type === "reasoning"), false);
});

test("an incomplete or in-progress item keeps its id", () => {
	const result = sanitizePayload({
		input: [
			{ type: "message", role: "assistant", id: "msg_partial" },
			{ type: "message", role: "assistant", id: "msg_running", status: "in_progress", content: [] },
			{ type: "function_call", id: "fc_partial", call_id: "call_1" },
			{ type: "unknown_kind", id: "x_1" },
		],
	}, "ids");
	assert.equal(result, undefined);
});

test("payloads with nothing to repair are left untouched", () => {
	for (const payload of [
		{ input: [{ type: "message", role: "user", content: "hi" }] },
		{ messages: [{ role: "user", content: "hi" }] },
		{ input: "not-an-array" },
		{},
		null,
		undefined,
		[],
	]) {
		assert.equal(sanitizePayload(payload, "ids"), undefined);
	}
});

test("non-object entries survive in place", () => {
	const result = sanitizePayload({ input: ["raw", 7, null, { type: "message", role: "user", id: "m1", content: "x" }] }, "ids");
	assert.deepEqual(result.payload.input, ["raw", 7, null, { type: "message", role: "user", content: "x" }]);
});

test("the resource attribution rejection is recognized in its real wording", () => {
	assert.equal(isResourceAttributionError(
		"Invalid request: Item with id 'msg_1' was created under a different Azure OpenAI resource and cannot be used. Please use the same resource for all requests.",
	), true);
	assert.equal(isResourceAttributionError("400 invalid_request_error"), false);
	assert.equal(isResourceAttributionError("429 token rate limit"), false);
	assert.equal(isResourceAttributionError("created under a different azure openai resource"), false);
});
