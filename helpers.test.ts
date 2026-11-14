/** Fast behavioural checks for configuration, output and binary selection. */
import assert from "node:assert/strict";
import test from "node:test";
import { _internals } from "./index.ts";
import { endpointUrl } from "./browser.ts";
import { assetName, defaultBinPath, downloadUrl, formatDownloadProgress, installTarget, resolveBin } from "./setup.ts";

const { readConfig, parseSubcommand, truncateText, isHttpUrl, formatSnapshot, TRUNC_MARKER } = _internals;

await test("configuration accepts only loopback hosts and positive decimal safe integers", () => {
	assert.deepEqual(readConfig({}).config, { host: "127.0.0.1", port: 9222, timeoutMs: 30000, maxBytes: 12288, maxRefs: 50 });
	for (const host of ["127.0.0.1", "localhost", "::1", " LOCALHOST "]) assert.ok(readConfig({ PI_LIGHTPANDA_HOST: host }).config);
	assert.match(readConfig({ PI_LIGHTPANDA_HOST: "example.com" }).error!, /loopback/);
	for (const key of ["PI_LIGHTPANDA_PORT", "PI_LIGHTPANDA_TIMEOUT_MS", "PI_LIGHTPANDA_MAX_BYTES", "PI_LIGHTPANDA_MAX_REFS"]) {
		for (const value of ["0", "-1", "abc", "9222abc", "1.5", "1e3", "0x10", "9007199254740992"]) {
			assert.ok(readConfig({ [key]: value }).error, `${key} rejects ${value}`);
		}
		assert.ok(readConfig({ [key]: " 42 " }).config);
		assert.ok(readConfig({ [key]: " " }).config);
	}
	assert.ok(readConfig({ PI_LIGHTPANDA_TIMEOUT_MS: "2147483647" }).error, "timeout plus CLI grace must fit Node timers");
	assert.ok(readConfig({ PI_LIGHTPANDA_PORT: "65536" }).error);
	assert.equal(readConfig({ PI_LIGHTPANDA_PORT: "65535" }).config?.port, 65535);
	assert.equal(endpointUrl(readConfig({}).config!), "ws://127.0.0.1:9222");
	assert.equal(endpointUrl(readConfig({ PI_LIGHTPANDA_HOST: "::1", PI_LIGHTPANDA_PORT: "9333" }).config!), "ws://[::1]:9333");
});

await test("binary resolution and asset selection match supported platforms", () => {
	const exists = (path: string) => path === "/installed/lightpanda";
	assert.equal(resolveBin({}, "/installed/lightpanda", exists), "/installed/lightpanda");
	assert.equal(resolveBin({}, "/installed/lightpanda", () => false), "lightpanda");
	assert.equal(resolveBin({ PI_LIGHTPANDA_BIN: "/env/lp" }, "/installed/lightpanda", exists), "/env/lp");
	assert.equal(resolveBin({ PI_LIGHTPANDA_BIN: " " }, "/installed/lightpanda", exists), "/installed/lightpanda");
	for (const [platform, arch, expected] of [
		["darwin", "arm64", "lightpanda-aarch64-macos"], ["darwin", "x64", "lightpanda-x86_64-macos"],
		["linux", "arm64", "lightpanda-aarch64-linux"], ["linux", "x64", "lightpanda-x86_64-linux"],
		["win32", "x64", null], ["freebsd", "x64", null],
	] as const) assert.equal(assetName(platform, arch), expected);
	assert.ok(defaultBinPath().endsWith("/.pi/agent/bin/lightpanda"));
	assert.equal(installTarget({}), defaultBinPath());
	assert.equal(installTarget({ PI_LIGHTPANDA_BIN: " " }), defaultBinPath());
	assert.equal(installTarget({ PI_LIGHTPANDA_BIN: "/x/lp" }), "/x/lp");
	assert.equal(downloadUrl("asset"), "https://github.com/lightpanda-io/browser/releases/download/nightly/asset");
	assert.equal(formatDownloadProgress(0), "Downloading Lightpanda: 0.0 MB");
	assert.equal(formatDownloadProgress(5 * 1024 * 1024, 20 * 1024 * 1024), "Downloading Lightpanda: 5.0 / 20.0 MB (25%)");
});

await test("commands and URL guards handle whitespace and reject non-HTTP schemes", () => {
	for (const [input, expected] of [["", ""], ["   ", ""], ["status", "status"], ["  start  ", "start"], ["stop extra", "stop"], ["bogus", "bogus"]]) {
		assert.equal(parseSubcommand(input), expected);
	}
	for (const url of ["https://example.com/x", "http://127.0.0.1:9222/json/list"]) assert.equal(isHttpUrl(url), true);
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) assert.equal(isHttpUrl(url), false);
});

await test("text and snapshots truncate safely at UTF-8 boundaries", () => {
	assert.equal(truncateText("hello", 100), "hello");
	for (const text of ["a".repeat(200), "😀".repeat(50)]) {
		const result = truncateText(text, 99);
		assert.ok(result.endsWith(TRUNC_MARKER));
		assert.ok(!result.includes("\uFFFD"));
		assert.ok(Buffer.byteLength(result.slice(0, -TRUNC_MARKER.length)) <= 99);
	}
	const refs = [
		{ ref: "e1", tag: "a", text: "Docs", selector: "a.nav", href: "/docs" },
		{ ref: "e2", tag: "input", text: "", selector: "input[name=q]", type: "search" },
	];
	const output = formatSnapshot(refs, "hello world", 10000);
	for (const value of ["[e1]", 'a "Docs"', "/docs", ":: a.nav", "[search]", "hello world"]) assert.ok(output.includes(value));
	assert.ok(formatSnapshot([], "body", 10000).includes("no interactive elements"));
	assert.ok(formatSnapshot(refs, "x".repeat(1000), 100).endsWith(TRUNC_MARKER));
});
