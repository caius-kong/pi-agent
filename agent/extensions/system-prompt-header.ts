/**
 * Footer status showing the effective system prompt size in tokens.
 *
 * ctx.getSystemPrompt() returns the prompt this turn actually sends. Tokens are
 * estimated with the chars/4 heuristic pi uses for its own context accounting
 * (core/compaction `estimateTokens`), so the number is comparable to the
 * footer's token stats instead of a provider-specific tokenizer's.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;

/** Same shape as pi's footer token counts: 812, 6.3k, 42k. */
function formatTokens(chars: number): string {
	const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		ctx.ui.setStatus("system-prompt", `System: ~${formatTokens(prompt.length)} tok`);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("system-prompt", undefined);
	});
}
