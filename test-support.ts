/** Shared offline fixtures. Keep mocks at the extension boundary, not inside production code. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import type { ExtractionOutput } from "./extract.ts";
import type { WizardUI } from "./setup.ts";

export const asset = "lightpanda-x86_64-linux";
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const binaryBytes = (command = "echo lightpanda-regression-fixture") => Buffer.concat([
	Buffer.from(`#!/bin/sh\n${command}\n#`), Buffer.alloc(1024 * 1024, 0x78),
]);
export const metadata = (sha256: string) => Response.json({
	assets: [{ name: asset, digest: `sha256:${sha256}`, updated_at: "2026-10-14T00:00:00Z" }],
});
export const assetFetcher = (bytes: Buffer, sha256 = digest(bytes)): typeof fetch => async (input) =>
	String(input).includes("api.github.com") ? metadata(sha256) : new Response(new Uint8Array(bytes), {
		headers: { "content-length": String(bytes.length) },
	});

export function fakeUi(answer = true) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const prompts: string[] = [];
	const ui: WizardUI = {
		confirm: async (_title, message) => { prompts.push(message); return answer; },
		notify: (message, type) => { notifications.push({ message, type }); },
		setStatus: (_key, text) => { statuses.push(text); },
	};
	return { ui, notifications, statuses, prompts };
}

export async function temporary(fn: (directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-lightpanda-test-"));
	try { await fn(directory); }
	finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function withEnv(patch: NodeJS.ProcessEnv, fn: () => Promise<void>) {
	const saved = Object.keys(patch).map((key) => [key, process.env[key]] as const);
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	try { await fn(); }
	finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

export function nodeBinary(path: string, source: string, nodePath = process.execPath) {
	// Shebangs cannot quote paths. A shell wrapper supports spaces/apostrophes
	// in both the Node executable and temporary fixture paths.
	const quotedNode = `'${nodePath.replaceAll("'", "'\\''")}'`;
	writeFileSync(path, `#!/bin/sh\nexec ${quotedNode} - "$@" <<'PI_LIGHTPANDA_NODE_FIXTURE'\n${source}\nPI_LIGHTPANDA_NODE_FIXTURE\n`, { mode: 0o755 });
}

export interface ToolResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	structuredContent?: ExtractionOutput;
}
interface Tool {
	name: string;
	parameters: TSchema;
	outputSchema?: TSchema;
	executionMode?: string;
	execute(id: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
type Context = { hasUI: boolean; ui: WizardUI };
type Handler = (event: unknown, ctx: Context) => unknown;

export function harness() {
	const tools = new Map<string, Tool>();
	const events = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
	const ctx = { hasUI: true, ui: fakeUi().ui };
	// This is intentionally a partial host: only registration/lifecycle are
	// mocked. Registered execute functions run unchanged, including validation.
	extension({
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler(args: string, ctx: Context): Promise<void> }) => commands.set(name, command),
		on: (name: string, handler: Handler) => events.set(name, handler),
	} as unknown as ExtensionAPI);
	return {
		tools, events, commands,
		command: (args: string) => commands.get("lightpanda")!.handler(args, ctx),
		shutdown: async () => { await events.get("session_shutdown")?.({}, ctx); },
		async call(name: string, params: unknown = {}) {
			const result = await tools.get(`lightpanda_${name}`)!.execute("test", params);
			const text = result.content.map((item) => item.text ?? "").join("\n");
			assert.ok(!result.isError, `${name}: ${text}`);
			return text;
		},
	};
}
