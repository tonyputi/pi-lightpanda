/** Regression tests: fake binaries, HTTP responses and DOM; no network or browser required. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import puppeteer from "puppeteer-core";
import extension, { _internals as browser } from "./index.ts";
import { _setupInternals as setup, type WizardUI } from "./setup.ts";

const asset = "lightpanda-x86_64-linux";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const binaryBytes = (command = "echo lightpanda-regression-fixture") => Buffer.concat([
	Buffer.from(`#!/bin/sh\n${command}\n#`), Buffer.alloc(1024 * 1024, 0x78),
]);
const metadata = (sha256: string) => new Response(JSON.stringify({
	assets: [{ name: asset, digest: `sha256:${sha256}`, updated_at: "2026-10-14T00:00:00Z" }],
}), { headers: { "content-type": "application/json" } });
const assetFetcher = (bytes: Buffer, sha256 = digest(bytes)): typeof fetch => async (input) =>
	String(input).includes("api.github.com") ? metadata(sha256) : new Response(new Uint8Array(bytes), {
		headers: { "content-length": String(bytes.length) },
	});

function fakeUi(answer = true) {
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

async function temporary(fn: (directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-lightpanda-regression-"));
	try { await fn(directory); }
	finally { rmSync(directory, { recursive: true, force: true }); }
}

async function withEnv(patch: NodeJS.ProcessEnv, fn: () => Promise<void>) {
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

function nodeBinary(path: string, source: string) {
	writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}

interface Tool {
	executionMode?: string;
	execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
}
type Context = { hasUI: boolean; ui: WizardUI };
type Handler = (event: unknown, ctx: Context) => unknown;
function harness() {
	const tools = new Map<string, Tool>();
	const events = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: Context) => Promise<void> }>();
	extension({
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: Context) => Promise<void> }) => commands.set(name, command),
		on: (name: string, handler: Handler) => events.set(name, handler),
	} as unknown as ExtensionAPI);
	return { tools, events, commands };
}

await test("version checks leave the event loop responsive and respect timeout/abort", async () => temporary(async (directory) => {
	const path = join(directory, "slow-lightpanda");
	nodeBinary(path, "setTimeout(() => console.log('slow-fixture'), 150)");
	let finished = false;
	const checking = setup.binaryUsable(path).then((value) => { finished = true; return value; });
	await delay(10);
	assert.equal(finished, false, "the timer ran while the version command was still running");
	assert.equal((await checking).version, "slow-fixture");
	assert.equal((await setup.binaryUsable(path, { timeoutMs: 10 })).usable, false);
	const controller = new AbortController();
	const aborted = setup.binaryUsable(path, { signal: controller.signal });
	controller.abort();
	await assert.rejects(aborted, /abort/i);
}));

await test("PATH overrides resolve identically for tools, setup and update", async () => temporary(async (directory) => {
	const path = join(directory, "custom-lightpanda");
	nodeBinary(path, "console.log('path-fixture')");
	const env = { PI_LIGHTPANDA_BIN: "custom-lightpanda", PATH: directory };
	assert.equal(browser.resolveBin(env), path);
	assert.equal(await setup.findInstalledBinary(env), path);
	assert.equal(setup.installTarget(env), path);
	const result = await setup.runSetupWizard(fakeUi().ui, { env, platform: "linux", arch: "x64" });
	assert.equal(result?.skipped, true);
	assert.equal(result?.target, path);
	const update = await setup.checkForUpdate({ env, platform: "linux", arch: "x64", fetcher: assetFetcher(binaryBytes()) });
	assert.ok(update.status === "update" && update.target === path);
	assert.throws(() => setup.installTarget({ PI_LIGHTPANDA_BIN: "missing-lightpanda", PATH: directory }), /explicit file path/);
	assert.equal(await setup.findInstalledBinary({ PI_LIGHTPANDA_BIN: "missing-lightpanda", PATH: directory }), null);
}));

await test("download refuses to overwrite an existing destination", async () => temporary(async (directory) => {
	const path = join(directory, "existing");
	writeFileSync(path, "keep-me");
	await assert.rejects(setup.downloadBinary("https://example.invalid/asset", path, undefined, { fetcher: assetFetcher(binaryBytes()) }), /EEXIST/);
	assert.equal(readFileSync(path, "utf8"), "keep-me");
}));

await test("download rejects tiny, incomplete and oversized responses, removing partial files", async () => temporary(async (directory) => {
	for (const [name, bytes, length, expected] of [
		["tiny", Buffer.from("error page"), 10, /suspiciously small/],
		["incomplete", binaryBytes(), binaryBytes().length + 1, /Content-Length/],
		["oversized", Buffer.from("x"), 256 * 1024 * 1024 + 1, /safety limit/],
	] as const) {
		const path = join(directory, name);
		await assert.rejects(setup.downloadBinary("https://example.invalid/asset", path, undefined, {
			fetcher: async () => new Response(new Uint8Array(bytes), { headers: { "content-length": String(length) } }),
		}), expected);
		assert.equal(existsSync(path), false, `${name} did not leave a partial executable`);
	}
}));

await test("stalled downloads time out and cancel their HTTP body", async () => temporary(async (directory) => {
	let cancelled = false;
	const path = join(directory, "stalled");
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(setup.downloadBinary("https://example.invalid/stalled", path, undefined, {
			timeoutMs: 30,
			fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
		}), /abort|timeout/i);
		assert.equal(cancelled, true);
		assert.equal(existsSync(path), false);
	} finally { clearTimeout(keepAlive); }
}));

await test("interrupted streams and user cancellation clean up partially written files", async () => temporary(async (directory) => {
	const path = join(directory, "interrupted");
	await assert.rejects(setup.downloadBinary("https://example.invalid/asset", path, undefined, {
		fetcher: async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(600 * 1024));
				setTimeout(() => controller.error(new Error("connection lost")), 20);
			},
		})),
	}), /connection lost/);
	assert.equal(existsSync(path), false);
	const controller = new AbortController();
	const cancelling = setup.downloadBinary("https://example.invalid/asset", path, undefined, {
		signal: controller.signal,
		fetcher: async () => new Response(new ReadableStream<Uint8Array>({
			start(stream) { stream.enqueue(new Uint8Array(600 * 1024)); },
		})),
	});
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(cancelling, /abort/i);
	assert.equal(existsSync(path), false);
}));

await test("setup and update preserve the previous binary on digest/executable/download failure", async () => temporary(async (directory) => {
	const target = join(directory, "lightpanda");
	const original = "#!/bin/sh\nexit 1\n";
	for (const wizard of [setup.runSetupWizard, setup.runUpdateWizard]) {
		for (const failure of ["digest", "executable", "download"] as const) {
			writeFileSync(target, original, { mode: 0o755 });
			const ui = fakeUi();
			const bytes = binaryBytes(failure === "executable" ? "exit 1" : undefined);
			const fetcher: typeof fetch = async (input) => {
				if (String(input).includes("api.github.com")) return metadata(failure === "digest" ? "f".repeat(64) : digest(bytes));
				if (failure === "download") return new Response("unavailable", { status: 503 });
				return new Response(new Uint8Array(bytes));
			};
			await assert.rejects(wizard(ui.ui, { env: { PI_LIGHTPANDA_BIN: target }, platform: "linux", arch: "x64", fetcher }), /digest|version|HTTP 503/);
			assert.equal(readFileSync(target, "utf8"), original);
			assert.deepEqual(readdirSync(directory), ["lightpanda"], "temporary directory was removed");
			assert.equal(ui.statuses.at(-1), undefined, "progress status was cleared");
		}
	}
}));

await test("wizard timeout clears progress and preserves the installed binary", async () => temporary(async (directory) => {
	const target = join(directory, "lightpanda");
	const original = "#!/bin/sh\nexit 1\n";
	writeFileSync(target, original, { mode: 0o755 });
	for (const wizard of [setup.runSetupWizard, setup.runUpdateWizard]) {
		const ui = fakeUi();
		const keepAlive = setTimeout(() => {}, 1000);
		try {
			await assert.rejects(wizard(ui.ui, {
				env: { PI_LIGHTPANDA_BIN: target }, platform: "linux", arch: "x64", downloadTimeoutMs: 30,
				fetcher: async (input) => String(input).includes("api.github.com") ? metadata("f".repeat(64)) : new Response(new ReadableStream()),
			}), /abort|timeout/i);
		} finally { clearTimeout(keepAlive); }
		assert.equal(readFileSync(target, "utf8"), original);
		assert.deepEqual(readdirSync(directory), ["lightpanda"]);
		assert.equal(ui.statuses.at(-1), undefined);
	}
}));

await test("setup verifies and installs a binary, and a late abort cannot replace the previous file", async () => temporary(async (directory) => {
	const target = join(directory, "lightpanda");
	const bytes = binaryBytes();
	const result = await setup.runSetupWizard(fakeUi().ui, {
		env: { PI_LIGHTPANDA_BIN: target }, platform: "linux", arch: "x64", fetcher: assetFetcher(bytes),
	});
	assert.equal(result?.version, "lightpanda-regression-fixture");
	assert.equal(digest(readFileSync(target)), digest(bytes));
	assert.deepEqual(readdirSync(directory), ["lightpanda"]);
	const before = readFileSync(target);
	const controller = new AbortController();
	const ui = fakeUi();
	ui.ui.setStatus = (_key, text) => {
		ui.statuses.push(text);
		if (text?.includes("100%")) controller.abort();
	};
	await assert.rejects(setup.runUpdateWizard(ui.ui, {
		env: { PI_LIGHTPANDA_BIN: target }, platform: "linux", arch: "x64",
		fetcher: assetFetcher(binaryBytes("echo changed")), signal: controller.signal,
	}), /abort/i);
	assert.deepEqual(readFileSync(target), before);
	assert.deepEqual(readdirSync(directory), ["lightpanda"]);
	assert.equal(ui.statuses.at(-1), undefined);
}));

const config = { host: "127.0.0.1", port: 65530, timeoutMs: 1500, maxBytes: 12000, maxRefs: 50 };
await test("missing/non-executable/early-exit servers return errors instead of crashing Pi", async () => temporary(async (directory) => {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("", { status: 404 });
	try {
		const notExecutable = join(directory, "not-executable");
		writeFileSync(notExecutable, "not executable", { mode: 0o644 });
		const earlyExit = join(directory, "early-exit");
		nodeBinary(earlyExit, "process.exit(7)");
		for (const path of [join(directory, "missing"), notExecutable, earlyExit]) {
			await withEnv({ PI_LIGHTPANDA_BIN: path }, async () => {
				const result = await browser.ensureServer(config);
				assert.ok("error" in result);
				if (path === earlyExit) assert.match(result.error, /7/);
				else assert.match(result.error, /setup/);
				assert.equal(await browser.stopManagedServer(), false, "failed spawn left no managed server");
			});
		}
	} finally {
		await browser.stopManagedServer();
		globalThis.fetch = savedFetch;
	}
}));

await test("readiness timeout terminates the unresponsive managed child", async () => temporary(async (directory) => {
	const path = join(directory, "server");
	nodeBinary(path, "setInterval(() => {}, 1000)");
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("", { status: 404 });
	try {
		await withEnv({ PI_LIGHTPANDA_BIN: path }, async () => {
			const result = await browser.ensureServer({ ...config, timeoutMs: 150 });
			assert.ok("error" in result && /within 150ms/.test(result.error));
			assert.equal(await browser.stopManagedServer(), false, "timed-out child was already reaped");
		});
	} finally {
		await browser.stopManagedServer();
		globalThis.fetch = savedFetch;
	}
}));

await test("concurrent server starts share one child and stopping waits for its exit", async () => temporary(async (directory) => {
	const path = join(directory, "server");
	const count = join(directory, "starts");
	nodeBinary(path, `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'start\\n'); setInterval(() => {}, 1000);`);
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => existsSync(count) ? Response.json({ Browser: "fake-browser" }) : new Response("", { status: 404 });
	try {
		await withEnv({ PI_LIGHTPANDA_BIN: path }, async () => {
			const results = await Promise.all([browser.ensureServer(config), browser.ensureServer(config)]);
			for (const result of results) assert.deepEqual(result, { reused: false });
			assert.equal(readFileSync(count, "utf8"), "start\n");
			assert.equal(await browser.stopManagedServer(), true);
			assert.equal(await browser.stopManagedServer(), false);
		});
	} finally {
		await browser.stopManagedServer();
		globalThis.fetch = savedFetch;
	}
}));

await test("session shutdown cancels a pending server startup", async () => temporary(async (directory) => {
	const path = join(directory, "server");
	nodeBinary(path, "setInterval(() => {}, 1000)");
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("", { status: 404 });
	try {
		await withEnv({ PI_LIGHTPANDA_BIN: path }, async () => {
			const pi = harness();
			const ui = fakeUi();
			const ctx = { hasUI: true, ui: ui.ui };
			const starting = pi.commands.get("lightpanda")!.handler("start", ctx);
			await delay(30);
			await pi.events.get("session_shutdown")!({}, ctx);
			await starting;
			assert.equal(await browser.stopManagedServer(), false);
			assert.ok(ui.notifications.some(({ message }) => /cancelled|exited/.test(message)));
		});
	} finally {
		await browser.stopManagedServer();
		globalThis.fetch = savedFetch;
	}
}));

await test("updates ask before restarting managed sessions and never restart external servers", async () => {
	for (const answer of [false, true]) {
		const ui = fakeUi(answer);
		let restarts = 0;
		await browser.restartAfterUpdate(ui.ui, { managed: true, external: false, restart: async () => { restarts++; return {}; } });
		assert.equal(ui.prompts.length, 1);
		assert.match(ui.prompts[0], /cookies and session state/);
		assert.equal(restarts, answer ? 1 : 0);
		assert.ok(ui.notifications.some(({ message }) => answer ? /restarted/.test(message) : /previous build/.test(message)));
	}
	const external = fakeUi();
	await browser.restartAfterUpdate(external.ui, { managed: false, external: true, restart: async () => { assert.fail("external server must never be restarted"); } });
	assert.equal(external.prompts.length, 0);
	assert.match(external.notifications[0].message, /external/);
	const failed = fakeUi();
	await browser.restartAfterUpdate(failed.ui, { managed: true, external: false, restart: async () => ({ error: "fixture failure" }) });
	assert.equal(failed.notifications.at(-1)?.type, "error");
});

await test("snapshots distinguish identical buttons and special IDs, refresh markers and omit passwords", () => {
	class FakeElement {
		tagName: string;
		innerText: string;
		value = "";
		attributes = new Map<string, string>();
		constructor(tag: string, text: string) { this.tagName = tag.toUpperCase(); this.innerText = text; }
		getBoundingClientRect() { return { width: 100, height: 20 }; }
		getAttribute(name: string) { return this.attributes.get(name) ?? null; }
		setAttribute(name: string, value: string) { this.attributes.set(name, value); }
		removeAttribute(name: string) { this.attributes.delete(name); }
	}
	const elements = [new FakeElement("button", "Save"), new FakeElement("button", "Delete"), new FakeElement("button", "Delete"), new FakeElement("input", "")];
	for (const el of elements) {
		el.setAttribute("id", 'duplicate:id["');
		el.setAttribute("class", "same-class");
		el.setAttribute("name", 'quoted"name');
	}
	elements[3].setAttribute("type", "password");
	elements[3].value = "do-not-expose-this-password";
	const attribute = "data-pi-lightpanda-ref";
	const find = (selector: string) => {
		if (selector === `[${attribute}]`) return elements.filter((el) => el.getAttribute(attribute));
		const token = selector.match(/^\[data-pi-lightpanda-ref="([^"]+)"\]$/)?.[1];
		return token ? elements.filter((el) => el.getAttribute(attribute) === token) : elements;
	};
	const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const savedElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: find, body: { innerText: "Save Delete Delete" } } });
	Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
	try {
		const first = browser.collectSnapshot(10, 1000);
		assert.equal(first.refs.length, 4, "identical labels are not deduplicated");
		assert.equal(new Set(first.refs.map((ref) => ref.selector)).size, 4);
		first.refs.forEach((ref, index) => assert.equal(find(ref.selector)[0], elements[index]));
		assert.ok(!JSON.stringify(first).includes(elements[3].value));
		const second = browser.collectSnapshot(2, 1000);
		assert.equal(second.refs.length, 2);
		for (const old of first.refs) assert.equal(find(old.selector).length, 0, "old snapshot selectors expire");
		assert.equal(elements[2].getAttribute(attribute), null);
	} finally {
		if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
		if (savedElement) Object.defineProperty(globalThis, "Element", savedElement); else Reflect.deleteProperty(globalThis, "Element");
	}
});

await test("shared-page tools run sequentially and invalid/stale inputs are marked as failed", async () => {
	const pi = harness();
	for (const name of ["navigate", "snapshot", "act", "eval", "extract"]) assert.equal(pi.tools.get(`lightpanda_${name}`)?.executionMode, "sequential");
	for (const [name, params] of [
		["fetch", { url: "file:///etc/passwd" }], ["navigate", { url: "javascript:alert(1)" }],
		["act", { action: "click", target: "e99" }], ["eval", { expression: "" }], ["run", { script: "untrusted.txt" }],
	] as const) {
		const result = await pi.tools.get(`lightpanda_${name}`)!.execute("test", params);
		assert.equal(result.isError, true, `${name} reported a real failed tool result`);
	}
});

await test("disconnect disposes only the owned context, even if context cleanup fails", async () => {
	const savedConnect = puppeteer.connect;
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ Browser: "external-fixture" });
	try {
		for (const fails of [false, true]) {
			let closed = 0;
			let disconnected = 0;
			const page = {
				isClosed: () => false, setDefaultTimeout: () => {}, goto: async () => {},
				waitForFunction: async () => {}, title: async () => "fixture", url: () => "https://example.invalid/",
			};
			puppeteer.connect = (async () => ({
				createBrowserContext: async () => ({
					newPage: async () => page,
					close: async () => { closed++; if (fails) throw new Error("already disconnected"); },
				}),
				disconnect: async () => { disconnected++; },
				close: async () => { assert.fail("external browser must never be closed"); },
			})) as unknown as typeof puppeteer.connect;
			const pi = harness();
			const ctx = { hasUI: true, ui: fakeUi().ui };
			const navigation = await pi.tools.get("lightpanda_navigate")!.execute("test", { url: "https://example.invalid/" });
			assert.ok(!navigation.isError);
			await pi.commands.get("lightpanda")!.handler("stop", ctx);
			assert.equal(closed, 1);
			assert.equal(disconnected, 1);
			await pi.events.get("session_shutdown")!({}, ctx);
			assert.equal(disconnected, 1, "cleanup is idempotent");
		}
	} finally {
		puppeteer.connect = savedConnect;
		globalThis.fetch = savedFetch;
		await browser.closePage();
	}
});

await test("a CDP connection completing after shutdown is disconnected, not published", async () => {
	const savedConnect = puppeteer.connect;
	const savedFetch = globalThis.fetch;
	let complete: ((value: unknown) => void) | undefined;
	let disconnected = 0;
	let contextOpened = false;
	globalThis.fetch = async () => Response.json({ Browser: "external-fixture" });
	puppeteer.connect = (() => new Promise((resolve) => { complete = resolve; })) as unknown as typeof puppeteer.connect;
	try {
		const pi = harness();
		const ctx = { hasUI: true, ui: fakeUi().ui };
		const navigation = pi.tools.get("lightpanda_navigate")!.execute("test", { url: "https://example.invalid/" });
		for (let attempt = 0; !complete && attempt < 50; attempt++) await delay(5);
		assert.ok(complete);
		await pi.events.get("session_shutdown")!({}, ctx);
		complete({
			createBrowserContext: async () => { contextOpened = true; assert.fail("ended session must not open a context"); },
			disconnect: async () => { disconnected++; },
		});
		assert.equal((await navigation).isError, true);
		assert.equal(contextOpened, false);
		assert.equal(disconnected, 1);
		await browser.closePage();
		assert.equal(disconnected, 1, "late connection was never published into shared state");
	} finally {
		puppeteer.connect = savedConnect;
		globalThis.fetch = savedFetch;
		await browser.closePage();
	}
});

await test("shutdown aborts background update work and suppresses late notifications", async () => temporary(async (directory) => {
	const path = join(directory, "lightpanda");
	writeFileSync(path, "installed fixture");
	const savedFetch = globalThis.fetch;
	let release: ((value: Response) => void) | undefined;
	let signal: AbortSignal | undefined;
	globalThis.fetch = async (_input, init) => {
		signal = init?.signal ?? undefined;
		return new Promise<Response>((resolve) => { release = resolve; });
	};
	try {
		await withEnv({ PI_LIGHTPANDA_BIN: path }, async () => {
			const pi = harness();
			const ui = fakeUi();
			const ctx = { hasUI: true, ui: ui.ui };
			pi.events.get("session_start")!({}, ctx);
			for (let attempt = 0; !release && attempt < 50; attempt++) await delay(5);
			assert.ok(release, "background check reached release metadata");
			await pi.events.get("session_shutdown")!({}, ctx);
			assert.equal(signal?.aborted, true);
			release(metadata("f".repeat(64)));
			await delay(20);
			assert.deepEqual(ui.notifications, []);
		});
	} finally { globalThis.fetch = savedFetch; }
}));
