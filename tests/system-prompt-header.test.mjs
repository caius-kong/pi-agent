import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const extensionUrl = new URL("../agent/extensions/system-prompt-header.ts", import.meta.url);

async function loadExtension() {
	const url = new URL(extensionUrl);
	url.searchParams.set("test", randomUUID());
	return import(url);
}

function fakePi() {
	const handlers = new Map();
	return { handlers, on: (event, handler) => handlers.set(event, handler) };
}

/** ctx stub: `prompt` is what getSystemPrompt() returns. */
function context(prompt) {
	const statuses = new Map();
	return {
		statuses,
		getSystemPrompt: () => prompt,
		ui: {
			setStatus: (key, text) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)),
		},
	};
}

test("formats like pi's footer token counts", async () => {
	const { default: register } = await loadExtension();
	const pi = fakePi();
	register(pi);

	const cases = [
		[800, "System: ~200 tok"],
		[8000, "System: ~2.0k tok"],
		[25123, "System: ~6.3k tok"],
		[40000, "System: ~10k tok"],
	];
	for (const [chars, text] of cases) {
		const ctx = context("x".repeat(chars));
		pi.handlers.get("agent_start")({}, ctx);
		assert.equal(ctx.statuses.get("system-prompt"), text);
	}
});

test("session shutdown clears the status", async () => {
	const { default: register } = await loadExtension();
	const pi = fakePi();
	register(pi);
	const ctx = context("x".repeat(8000));

	pi.handlers.get("agent_start")({}, ctx);
	assert.equal(ctx.statuses.has("system-prompt"), true);

	pi.handlers.get("session_shutdown")({}, ctx);
	assert.equal(ctx.statuses.has("system-prompt"), false);
});
