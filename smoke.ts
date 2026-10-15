/** Optional integration check against an installed Lightpanda; only ephemeral loopback servers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { findInstalledBinary, type WizardUI } from "./setup.ts";

interface ToolResult { isError?: boolean; content: Array<{ text?: string }> }
interface Tool { name: string; execute(id: string, params: unknown): Promise<ToolResult> }
const ui: WizardUI = { confirm: async () => { throw new Error("smoke test must never prompt or download"); }, notify: () => {} };
const ctx = { hasUI: true, ui };
function harness() {
	const tools = new Map<string, Tool>();
	let command: (args: string, context: typeof ctx) => Promise<void>;
	let shutdown: () => Promise<void>;
	extension({
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (_name: string, value: { handler: typeof command }) => { command = value.handler; },
		on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
	} as unknown as ExtensionAPI);
	return {
		async call(name: string, params: unknown = {}) {
			const result = await tools.get(`lightpanda_${name}`)!.execute("smoke", params);
			const text = result.content.map((item) => item.text ?? "").join("\n");
			assert.ok(!result.isError, `${name}: ${text}`);
			return text;
		},
		tools,
		command: (args: string) => command(args, ctx),
		shutdown: () => shutdown(),
	};
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}
async function close(server: Server) {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort() {
	const server = createServer();
	const port = await listen(server);
	await close(server);
	return port;
}
async function reachable(port: number): Promise<boolean> {
	try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
	catch { return false; }
}

const bin = await findInstalledBinary();
assert.ok(bin, "install Lightpanda first with /lightpanda setup, or set PI_LIGHTPANDA_BIN");
process.env.PI_LIGHTPANDA_BIN = bin;
process.env.PI_LIGHTPANDA_HOST = "127.0.0.1";
process.env.PI_LIGHTPANDA_TIMEOUT_MS = "10000";
const site = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(`<!doctype html><html><head><title>Lightpanda smoke</title></head><body>
<button id="duplicate" class="action" onclick="document.body.setAttribute('data-clicked','first')">Go</button>
<button id="duplicate" class="action" onclick="document.body.setAttribute('data-clicked','second')">Go</button>
<button id="odd:id[name]" onclick="document.body.setAttribute('data-clicked','special')">Special</button>
<input type="password" value="fixture-password-not-for-output">
</body></html>`);
});
const port = await listen(site);
const url = `http://127.0.0.1:${port}/`;
try {
	const managedPort = await freePort();
	process.env.PI_LIGHTPANDA_PORT = String(managedPort);
	const managed = harness();
	try {
		await managed.call("navigate", { url });
		const snapshot = await managed.call("snapshot");
		assert.ok(!snapshot.includes("fixture-password-not-for-output"));
		const refs = [...snapshot.matchAll(/^\[(e\d+)\] button/gm)].map((match) => match[1]);
		assert.equal(refs.length, 3, "all buttons, including identical ones, have references");
		await managed.call("act", { action: "click", target: refs[1] });
		assert.equal(await managed.call("eval", { expression: "document.body.getAttribute('data-clicked')" }), "second");
		assert.equal((await managed.tools.get("lightpanda_act")!.execute("stale", { action: "click", target: refs[0] })).isError, true);
		const fresh = await managed.call("snapshot");
		const special = fresh.match(/^\[(e\d+)\] button "Special"/m)?.[1];
		assert.ok(special);
		await managed.call("act", { action: "click", target: special });
		assert.equal(await managed.call("eval", { expression: "document.body.getAttribute('data-clicked')" }), "special");
		console.log("ok real CDP: unique refs, correct clicks, stale-ref rejection, password omission");
	} finally { await managed.shutdown(); }
	assert.equal(await reachable(managedPort), false, "managed server was stopped on shutdown");
	console.log("ok managed server cleanup");

	const externalPort = await freePort();
	const external = spawn(bin, ["serve", "--host", "127.0.0.1", "--port", String(externalPort)], { stdio: "ignore" });
	let spawnError: Error | undefined;
	external.once("error", (error) => { spawnError = error; });
	try {
		for (let attempt = 0; attempt < 100 && !(await reachable(externalPort)); attempt++) {
			if (spawnError) throw spawnError;
			assert.equal(external.exitCode, null, "external fixture server exited unexpectedly");
			await delay(50);
		}
		assert.equal(await reachable(externalPort), true);
		process.env.PI_LIGHTPANDA_PORT = String(externalPort);
		const reused = harness();
		try {
			await reused.call("navigate", { url });
			await reused.command("stop");
			assert.equal(await reachable(externalPort), true, "stop left external server untouched");
		} finally { await reused.shutdown(); }
		assert.equal(await reachable(externalPort), true, "shutdown left external server untouched");
		console.log("ok external server reuse and preservation");
	} finally {
		// This fixture belongs to the smoke script, not the extension.
		if (external.exitCode === null && external.signalCode === null && external.pid) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { external.kill("SIGKILL"); resolve(); }, 2000);
				external.once("exit", () => { clearTimeout(timer); resolve(); });
				external.kill();
			});
		}
	}
} finally { await close(site); }
console.log("all Lightpanda smoke checks passed");
