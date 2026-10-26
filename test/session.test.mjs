import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const text = (value) => [{ type: "text", text: value }];
const response = (stopReason, content = []) => ({
	role: "assistant",
	api: "openai-completions",
	provider: "retry-test",
	model: "offline",
	content,
	stopReason,
	timestamp: Date.now(),
	usage: {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

async function createTestSession(t, { reply = () => response("stop", text("Recovered.")), retry = { enabled: false } } = {}) {
	const network = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
	const directory = await mkdtemp(join(tmpdir(), "pi-retry-test-"));
	let session;
	t.after(async () => {
		session?.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	const settingsManager = SettingsManager.inMemory({
		retry,
		compaction: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		additionalExtensionPaths: [packageDir],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Offline retry integration test.",
	});
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.filter(extension => extension.commands.has("retry")).length, 1);

	const requests = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("retry-test", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "offline-test-key",
		models: [{
			id: "offline", name: "Offline test", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768, maxTokens: 256,
		}],
		streamSimple(_model, context) {
			requests.push(structuredClone(context.messages));
			const message = reply(requests.length);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: message };
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						yield { type: "error", reason: message.stopReason, error: message };
					} else {
						yield { type: "done", reason: message.stopReason, message };
					}
				},
				result: async () => message,
			};
		},
	});
	const sessionManager = SessionManager.inMemory(directory);
	sessionManager.appendMessage({ role: "user", content: text("Do the work."), timestamp: Date.now() });
	sessionManager.appendMessage(response("toolUse", [
		{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "result.txt", content: "done" } },
	]));
	sessionManager.appendMessage({
		role: "toolResult", toolCallId: "write-1", toolName: "write",
		content: text("File written."), isError: false, timestamp: Date.now(),
	});
	sessionManager.appendMessage({ ...response("error"), errorMessage: "503 Service Unavailable" });
	({ session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		model: modelRuntime.getModel("retry-test", "offline"),
		modelRuntime, settingsManager, sessionManager, resourceLoader,
		thinkingLevel: "off",
		tools: [],
	}));
	const errors = [];
	const notices = [];
	await session.bindExtensions({
		mode: "tui",
		uiContext: { notify(message) { notices.push(message); } },
		onError: (error) => errors.push(error),
		commandContextActions: {
			navigateTree: (id, options) => session.navigateTree(id, options),
		},
	});
	// Record the same entry as a direct !git status invocation, without running a shell.
	session.recordBashResult("git status --short", {
		output: "", exitCode: 0, cancelled: false, truncated: false,
	});
	return { session, sessionManager, settingsManager, requests, notices, errors, network };
}

test("Pi loads the package and resumes a real session without losing its checkpoint", { timeout: 10000 }, async (t) => {
	const { session, sessionManager, requests, notices, errors, network } = await createTestSession(t);
	const checkpoint = structuredClone(sessionManager.getBranch());

	await session.prompt("/retry");
	await session.waitForIdle();
	assert.deepEqual(errors, []);
	assert.equal(requests.length, 1);
	assert(requests[0].some(message => message.role === "toolResult" && message.toolCallId === "write-1"));
	const branch = sessionManager.getBranch();
	assert.deepEqual(branch.slice(0, checkpoint.length), checkpoint);
	assert.equal(branch.filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
	const continuation = branch.filter(entry => entry.type === "custom_message" && entry.customType === "manual-retry");
	assert.equal(continuation.length, 1);
	assert.equal(continuation[0].display, false);
	assert.equal(session.getLastAssistantText(), "Recovered.");

	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(requests.length, 1, "a successful recovery must not be retried again");
	assert.match(notices.at(-1), /Nothing to retry/);
	assert.deepEqual(errors, []);
	assert.equal(network.mock.callCount(), 0);
});


const nativeRetry = { enabled: true, maxRetries: 15, baseDelayMs: 1, maxAgentDelayMs: 1 };
const errorResponse = (errorMessage) => ({ ...response("error"), errorMessage });

test("manual retry stops a repeated provider error before Pi's 15 native retries", { timeout: 10000 }, async (t) => {
	const { session, sessionManager, settingsManager, requests, notices, errors, network } = await createTestSession(t, {
		retry: nativeRetry,
		reply: () => errorResponse("503 Service Unavailable"),
	});
	const scheduled = [];
	session.subscribe(event => { if (event.type === "auto_retry_start") scheduled.push(event); });
	await Promise.all([session.prompt("/retry"), session.prompt("/retry")]);
	await session.waitForIdle();
	assert.equal(requests.length, 1);
	assert.equal(scheduled.length, 0);
	assert.equal(sessionManager.getBranch().at(-1).message.stopReason, "error");
	assert.equal(sessionManager.getBranch().at(-1).message.errorMessage, "503 Service Unavailable");
	assert(notices.some(message => /same failure/i.test(message)));
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(requests.length, 1);
	await session.prompt("/retry --force");
	await session.waitForIdle();
	assert.equal(requests.length, 2);
	assert.equal(scheduled.length, 0);
	assert.equal(settingsManager.getRetrySettings().maxRetries, 15);
	assert.deepEqual(errors, []);
	assert.equal(network.mock.callCount(), 0);
});

test("manual retry has a three-request budget even when provider errors change", { timeout: 10000 }, async (t) => {
	const { session, requests, notices, errors } = await createTestSession(t, {
		retry: nativeRetry,
		reply: (attempt) => errorResponse("503 changing failure " + attempt),
	});
	const scheduled = [];
	session.subscribe(event => { if (event.type === "auto_retry_start") scheduled.push(event); });
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(requests.length, 3);
	assert.equal(scheduled.length, 2);
	assert.match(notices.at(-1), /3 failed provider requests/);
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(requests.length, 3);
	assert.deepEqual(errors, []);
});

test("ordinary user prompts retain their native retry policy after a manual attempt stops", { timeout: 10000 }, async (t) => {
	const { session, requests, errors } = await createTestSession(t, {
		retry: { ...nativeRetry, maxRetries: 2 },
		reply: () => errorResponse("503 Service Unavailable"),
	});
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(requests.length, 1);
	await session.prompt("A new user task.");
	await session.waitForIdle();
	assert.equal(requests.length, 4, "the new prompt still gets its initial request plus two native retries");
	assert.deepEqual(errors, []);
});
