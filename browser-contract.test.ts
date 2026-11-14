/** Exercise complete tool paths against small fake processes/CDP objects. No network. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { fakeUi, harness, nodeBinary, temporary, withEnv } from "./test-support.ts";

await test("CLI tools return output, reject unsafe inputs, and report process errors/cancellation", async () => temporary(async (directory) => {
	const bin = join(directory, "lightpanda");
	await withEnv({ PI_LIGHTPANDA_BIN: bin }, async () => {
		const pi = harness();
		try {
			nodeBinary(bin, "console.log('fixture output')");
			assert.match(await pi.call("run", { script: "trusted.js" }), /fixture output/);
			assert.match(await pi.call("fetch", { url: "https://fixture.test/" }), /fixture output/);
			for (const script of ["../escape.js", "invalid.txt"]) {
				assert.equal((await pi.tools.get("lightpanda_run")!.execute("invalid", { script })).isError, true);
			}
			nodeBinary(bin, "console.error('fixture failure'); process.exit(7)");
			for (const [name, params] of [["run", { script: "trusted.js" }], ["fetch", { url: "https://fixture.test/" }]] as const) {
				const failure = await pi.tools.get(`lightpanda_${name}`)!.execute("error", params);
				assert.equal(failure.isError, true);
				assert.match(failure.content[0].text!, /fixture failure/);
			}
			const signal = AbortSignal.abort();
			assert.equal((await pi.tools.get("lightpanda_fetch")!.execute("cancel", { url: "https://fixture.test/" }, signal)).isError, true);
		} finally { await pi.shutdown(); }
	});
}));

await test("browser tools cover all actions, stale refs, failures and isolated instance cleanup", async (t) => {
	const calls: string[] = [];
	let contexts = 0;
	let closed = 0;
	t.mock.method(globalThis, "fetch", async () => Response.json({ Browser: "external fixture" }));
	t.mock.method(puppeteer, "connect", async () => ({
		createBrowserContext: async () => {
			contexts++;
			let gone = false;
			const page = {
				isClosed: () => gone,
				setDefaultTimeout: () => {},
				goto: async () => {}, waitForFunction: async () => {},
				title: async () => "Fixture", url: () => "https://fixture.test/",
				evaluate: async (expression: unknown) => {
					if (typeof expression === "function") return { refs: [{ ref: "e1", selector: "#field", tag: "input", text: "Field" }], text: "Fixture body" };
					if (expression === "closed") throw new Error("Target closed");
					return expression === "object" ? { value: 42 } : "observed value";
				},
				$$eval: async () => 1,
				$eval: async (_selector: string, fn: (el: unknown, value: string) => void, value: string) => fn({
					focus: () => {}, value: "", dispatchEvent: (event: Event) => calls.push(event.type),
				}, value),
				click: async () => { calls.push("click"); }, hover: async () => { calls.push("hover"); },
				type: async () => { calls.push("type"); }, select: async () => { calls.push("select"); },
				focus: async () => { calls.push("focus"); }, keyboard: { press: async () => { calls.push("press"); } },
			};
			return { newPage: async () => page, close: async () => { gone = true; closed++; } };
		},
		disconnect: async () => {},
	}));
	const first = harness();
	const second = harness();
	try {
		await first.call("navigate", { url: "https://fixture.test/" });
		await second.call("navigate", { url: "https://fixture.test/" });
		assert.equal(contexts, 2, "each extension owns a separate context/page");
		assert.match(await first.call("snapshot"), /\[e1\].*Fixture body/s);
		await first.call("act", { action: "click", target: "e1" });
		assert.equal((await first.tools.get("lightpanda_act")!.execute("stale", { action: "click", target: "e1" })).isError, true);
		for (const action of ["hover", "type", "fill", "select", "press"]) await first.call("act", { action, target: "#field", value: "value" });
		assert.deepEqual(calls, ["click", "hover", "type", "input", "change", "select", "focus", "press"]);
		assert.equal(await first.call("eval", { expression: "object" }), '{"value":42}');
		assert.equal((await first.tools.get("lightpanda_eval")!.execute("long", { expression: "x".repeat(4001) })).isError, true);
		assert.equal((await first.tools.get("lightpanda_act")!.execute("empty", { action: "click", target: " " })).isError, true);
		assert.equal((await first.tools.get("lightpanda_eval")!.execute("closed", { expression: "closed" })).isError, true);
		assert.equal(closed, 1, "disconnected targets release only their own context");
		await first.shutdown();
		assert.equal(await second.call("eval", { expression: "value" }), "observed value");
		assert.equal(contexts, 2, "the surviving instance reuses its own page");
	} finally { await first.shutdown(); await second.shutdown(); }
	assert.equal(closed, 2);
});

await test("commands/status handle misconfiguration, headless setup/update, and unknown subcommands", async (t) => temporary(async (directory) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ Browser: "external fixture" }));
	const bin = join(directory, "lightpanda");
	nodeBinary(bin, "console.log('fixture-version')");
	await withEnv({ PI_LIGHTPANDA_BIN: bin }, async () => {
		const pi = harness();
		const ui = fakeUi();
		try {
			assert.match(await pi.call("status"), /fixture-version[\s\S]*external/);
			for (const args of ["", "start", "stop", "setup", "update", "unknown"]) {
				await pi.commands.get("lightpanda")!.handler(args, { hasUI: false, ui: ui.ui });
			}
			assert.ok(ui.notifications.some(({ message }) => message.includes("interactive")));
			assert.ok(ui.notifications.some(({ message }) => message.includes("unknown subcommand")));
		} finally { await pi.shutdown(); }
	});
	t.mock.method(console, "error", () => {});
	await withEnv({ PI_LIGHTPANDA_HOST: "remote.example" }, async () => {
		const invalid = harness();
		assert.equal(invalid.tools.size, 0);
		await invalid.command("status");
	});
}));
