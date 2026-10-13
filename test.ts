/**
 * Self-check for the pure helpers exported via _internals. No framework, no
 * network, no lightpanda binary: run with `npm test` (Node 22.18+ strips
 * types natively).
 */
import assert from "node:assert";
import { _internals } from "./index.ts";
import { _setupInternals } from "./setup.ts";

const { readConfig, resolveBin, parseSubcommand, truncateText, isHttpUrl, formatSnapshot, collectSnapshot, fetchArgs, endpointUrl, TRUNC_MARKER, LOOPBACK_HOSTS } = _internals;

// --- readConfig -----------------------------------------------------------
{
	const keys = ["PI_LIGHTPANDA_BIN", "PI_LIGHTPANDA_HOST", "PI_LIGHTPANDA_PORT", "PI_LIGHTPANDA_TIMEOUT_MS", "PI_LIGHTPANDA_MAX_BYTES", "PI_LIGHTPANDA_MAX_REFS"];
	const keep = keys.map((k) => [k, process.env[k]] as const);
	for (const [k] of keep) delete process.env[k];

	const d = readConfig();
	assert.ok(d.config && !d.error, "defaults accepted");
	assert.equal(d.config!.host, "127.0.0.1");
	assert.equal(d.config!.port, 9222);

	process.env.PI_LIGHTPANDA_HOST = "example.com";
	assert.ok(readConfig().error?.includes("loopback"), "remote host refused");
	delete process.env.PI_LIGHTPANDA_HOST;

	for (const h of ["127.0.0.1", "localhost", "::1"]) {
		process.env.PI_LIGHTPANDA_HOST = h;
		assert.ok(readConfig().config, `loopback host ${h} accepted`);
		delete process.env.PI_LIGHTPANDA_HOST;
	}

	process.env.PI_LIGHTPANDA_PORT = "99999";
	assert.ok(readConfig().error?.includes("PORT"), "bad port rejected");
	process.env.PI_LIGHTPANDA_PORT = "9333";
	assert.equal(readConfig().config!.port, 9333, "custom port kept");
	delete process.env.PI_LIGHTPANDA_PORT;

	process.env.PI_LIGHTPANDA_TIMEOUT_MS = "abc";
	assert.ok(readConfig().error?.includes("TIMEOUT"), "bad timeout rejected");
	delete process.env.PI_LIGHTPANDA_TIMEOUT_MS;

	process.env.PI_LIGHTPANDA_MAX_BYTES = "0";
	assert.ok(readConfig().error, "zero maxBytes rejected");
	delete process.env.PI_LIGHTPANDA_MAX_BYTES;

	for (const [k, v] of keep) if (v !== undefined) process.env[k] = v;
	console.log("ok readConfig");
}

// --- resolveBin ------------------------------------------------------------
{
	const fakeExists = (p: string) => p === "/installed/lightpanda";
	assert.equal(resolveBin({}, "/installed/lightpanda", fakeExists), "/installed/lightpanda", "install path picked when present");
	assert.equal(resolveBin({}, "/installed/lightpanda", () => false), "lightpanda", "PATH fallback when not installed");
	assert.equal(resolveBin({ PI_LIGHTPANDA_BIN: "/env/lp" }, "/installed/lightpanda", fakeExists), "/env/lp", "env wins over install path");
	assert.equal(resolveBin({ PI_LIGHTPANDA_BIN: "   " }, "/installed/lightpanda", fakeExists), "/installed/lightpanda", "blank env ignored");
	console.log("ok resolveBin");
}

// --- parseSubcommand ------------------------------------------------------
{
	assert.equal(parseSubcommand(""), "");
	assert.equal(parseSubcommand("   "), "");
	assert.equal(parseSubcommand("status"), "status");
	assert.equal(parseSubcommand("  start  "), "start");
	assert.equal(parseSubcommand("stop extra"), "stop");
	assert.equal(parseSubcommand("bogus"), "bogus");
	console.log("ok parseSubcommand");
}

// --- truncateText ---------------------------------------------------------
{
	assert.equal(truncateText("hello", 100), "hello", "short text untouched");
	const long = "a".repeat(200);
	const t = truncateText(long, 100);
	assert.ok(t.endsWith(TRUNC_MARKER), "marker appended");
	assert.ok(t.length < long.length, "actually shorter");
	// Multi-byte safety: never split a UTF-8 sequence.
	const emoji = "😀".repeat(50);
	const te = truncateText(emoji, 100);
	assert.ok(te.endsWith(TRUNC_MARKER), "emoji truncation marked");
	assert.equal(Buffer.byteLength(te.replace(TRUNC_MARKER, ""), "utf8") <= 100, true, "byte cap respected");
	console.log("ok truncateText");
}

// --- isHttpUrl ------------------------------------------------------------
{
	assert.equal(isHttpUrl("https://example.com/x"), true);
	assert.equal(isHttpUrl("http://127.0.0.1:9222/json/list"), true);
	assert.equal(isHttpUrl("file:///etc/passwd"), false, "file: refused");
	assert.equal(isHttpUrl("javascript:alert(1)"), false, "javascript: refused");
	assert.equal(isHttpUrl("not a url"), false, "garbage refused");
	assert.equal(isHttpUrl(""), false, "empty refused");
	console.log("ok isHttpUrl");
}

// --- formatSnapshot -------------------------------------------------------
{
	const refs = [
		{ ref: "e1", tag: "a", text: "Docs", selector: "a.nav", href: "/docs" },
		{ ref: "e2", tag: "input", text: "", selector: "input[name=q]", type: "search" },
	];
	const out = formatSnapshot(refs, "hello world", 10_000);
	assert.ok(out.includes("[e1]"), "ref marker present");
	assert.ok(out.includes('a "Docs"'), "tag + text present");
	assert.ok(out.includes("/docs"), "href present");
	assert.ok(out.includes(":: a.nav"), "selector present");
	assert.ok(out.includes("hello world"), "page text present");

	const empty = formatSnapshot([], "body", 10_000);
	assert.ok(empty.includes("no interactive elements"), "empty refs handled");

	const capped = formatSnapshot(refs, "x".repeat(1000), 100);
	assert.ok(capped.endsWith(TRUNC_MARKER), "snapshot truncated");
	console.log("ok formatSnapshot");
}

// --- fetchArgs ------------------------------------------------------------
{
	const a = fetchArgs("https://example.com", "markdown", 3000, 12288);
	assert.deepEqual(a, ["fetch", "https://example.com", "--dump", "markdown", "--dump-max-bytes", "12288", "--wait-ms", "3000"]);
	console.log("ok fetchArgs");
}

// --- endpointUrl ----------------------------------------------------------
{
	const cfg = (readConfig() as { config: { bin: string; host: string; port: number; timeoutMs: number; maxBytes: number; maxRefs: number } }).config;
	assert.equal(endpointUrl({ ...cfg, port: 9222 }), "ws://127.0.0.1:9222");
	assert.equal(endpointUrl({ ...cfg, host: "::1", port: 9333 }), "ws://[::1]:9333", "ipv6 bracketed");
	console.log("ok endpointUrl");
}

// --- collectSnapshot ------------------------------------------------------
{
	// Runs in the page, so here we only check shape/arity/source markers.
	assert.equal(collectSnapshot.length, 2, "takes (maxRefs, maxBytes)");
	const src = collectSnapshot.toString();
	for (const marker of ["querySelectorAll", "getBoundingClientRect", "innerText", "maxRefs", "maxBytes", "href"]) {
		assert.ok(src.includes(marker), `page script mentions ${marker}`);
	}
	assert.ok(!src.includes("fetch(") && !src.includes("XMLHttpRequest"), "no network in page script");
	assert.ok(!src.includes("process.") && !src.includes("require("), "no node refs in page script (must serialize)");
	assert.ok(LOOPBACK_HOSTS.has("127.0.0.1") && LOOPBACK_HOSTS.has("::1"), "loopback set sane");
	console.log("ok collectSnapshot");
}

// --- setup (pure parts; download flow is manual) ---------------------------
{
	const { assetName, defaultBinPath, downloadUrl, binaryUsable, installTarget, runSetupWizard } = _setupInternals;

	assert.equal(assetName("darwin", "arm64"), "lightpanda-aarch64-macos");
	assert.equal(assetName("darwin", "x64"), "lightpanda-x86_64-macos");
	assert.equal(assetName("linux", "x64"), "lightpanda-x86_64-linux");
	assert.equal(assetName("linux", "arm64"), "lightpanda-aarch64-linux");
	assert.equal(assetName("win32", "x64"), null, "no native windows binary");
	assert.equal(assetName("freebsd", "x64"), null, "unknown platform -> null");

	assert.ok(defaultBinPath().endsWith(joinParts(".pi", "agent", "bin", "lightpanda")), "default under ~/.pi/agent/bin");
	assert.ok(downloadUrl("lightpanda-x86_64-linux").startsWith("https://github.com/lightpanda-io/browser/releases/download/nightly/"), "release URL sane");

	assert.equal(installTarget({}), defaultBinPath(), "no env -> default install path");
	assert.equal(installTarget({ PI_LIGHTPANDA_BIN: "/x/lp" }), "/x/lp", "env -> install there");
	assert.equal(installTarget({ PI_LIGHTPANDA_BIN: "   " }), defaultBinPath(), "blank env -> default");

	assert.equal(binaryUsable("/definitely/not/here-lightpanda").usable, false, "missing binary -> unusable");

	// The wizard, with a fake ui (same shape as pi's ctx.ui).
	const makeUi = (confirmResult: boolean) => {
		const calls: string[] = [];
		return {
			calls,
			ui: {
				confirm: async () => {
					calls.push("confirm");
					return confirmResult;
				},
				notify: (message: string) => {
					calls.push(`notify:${message}`);
				},
			},
		};
	};

	await assert.rejects(
		() => runSetupWizard(makeUi(true).ui, { platform: "win32", arch: "x64" }),
		/unsupported platform/,
		"windows refused",
	);

	// A usable binary short-circuits before any download.
	const up = makeUi(true);
	const done = await runSetupWizard(up.ui, { env: { PI_LIGHTPANDA_BIN: "/bin/true" } as NodeJS.ProcessEnv });
	assert.ok(done && done.skipped && done.target === "/bin/true", "usable binary -> skipped, no download");
	assert.equal(up.calls.length, 0, "skipped flow asks nothing");

	const no = makeUi(false);
	assert.equal(await runSetupWizard(no.ui, { env: { PI_LIGHTPANDA_BIN: "/bin/false" } as NodeJS.ProcessEnv }), null, "declined download -> null");
	assert.ok(no.calls.some((c) => c.startsWith("notify:lightpanda: setup cancelled")), "cancel is reported");

	console.log("ok setup");
}

function joinParts(...parts: string[]): string {
	return parts.join("/");
}

console.log("\nall tests passed");
