/** Successful installs/updates and metadata validation; failure recovery lives in reliability.test.ts. */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as setup from "./setup.ts";
import { asset, assetFetcher, binaryBytes, digest, fakeUi, metadata, temporary } from "./test-support.ts";

await test("streamed downloads report progress, persist bytes and return the observed digest", async () => temporary(async (directory) => {
	const bytes = binaryBytes();
	const path = join(directory, "lightpanda");
	const progress: Array<[number, number | undefined]> = [];
	const sha256 = await setup.downloadBinary("https://example.invalid/asset", path, (count, total) => progress.push([count, total]), { fetcher: assetFetcher(bytes) });
	assert.equal(sha256, digest(bytes));
	assert.deepEqual(readFileSync(path), bytes);
	assert.equal(statSync(path).mode & 0o777, 0o755);
	assert.deepEqual(progress[0], [0, bytes.length]);
	assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
}));

await test("update metadata compares digests, asks before replacement, and verifies the installed file", async () => temporary(async (directory) => {
	const path = join(directory, "lightpanda");
	const bytes = binaryBytes();
	writeFileSync(path, bytes, { mode: 0o755 });
	const opts = { env: { PI_LIGHTPANDA_BIN: path }, platform: "linux", arch: "x64", fetcher: assetFetcher(bytes) };
	assert.deepEqual(await setup.fetchLatestAssetInfo(asset, opts.fetcher), { sha256: digest(bytes), updatedAt: "2026-10-14T00:00:00Z" });
	const current = fakeUi();
	assert.equal((await setup.runUpdateWizard(current.ui, opts))?.status, "current");
	assert.deepEqual(current.prompts, []);
	const newBytes = binaryBytes("echo updated-fixture");
	const updateOpts = { ...opts, fetcher: assetFetcher(newBytes) };
	const declined = fakeUi(false);
	assert.equal(await setup.runUpdateWizard(declined.ui, updateOpts), null);
	assert.equal(declined.prompts.length, 1);
	assert.deepEqual(readFileSync(path), bytes);
	const accepted = fakeUi();
	const result = await setup.runUpdateWizard(accepted.ui, updateOpts);
	assert.ok(result?.status === "updated");
	assert.equal(result.version, "updated-fixture");
	assert.equal(await setup.sha256File(path), digest(newBytes));
	assert.equal(accepted.statuses.at(-1), undefined);
}));

await test("setup and update handle unsupported platforms, missing binaries and declined downloads without network", async () => {
	const ui = fakeUi(false);
	const env = { PI_LIGHTPANDA_BIN: "/definitely/not/here-lightpanda" };
	assert.equal((await setup.binaryUsable(env.PI_LIGHTPANDA_BIN)).usable, false);
	await assert.rejects(setup.runSetupWizard(ui.ui, { env, platform: "win32", arch: "x64" }), /unsupported platform/);
	assert.deepEqual(await setup.checkForUpdate({ env }), { status: "missing" });
	assert.equal(await setup.runSetupWizard(ui.ui, { env, platform: "linux", arch: "x64" }), null);
	assert.match(ui.notifications.at(-1)!.message, /setup cancelled/);
});

await test("release metadata rejects malformed responses with a useful error", async () => {
	for (const value of [null, {}, { assets: {} }, { assets: [null] }, { assets: [] },
		{ assets: [{ name: asset, digest: "sha256:invalid", updated_at: "invalid" }] }]) {
		await assert.rejects(setup.fetchLatestAssetInfo(asset, async () => Response.json(value)), /metadata unavailable/);
	}
	await assert.rejects(setup.fetchLatestAssetInfo(asset, async () => new Response(null, { status: 503 })), /HTTP 503/);
	assert.ok(await setup.fetchLatestAssetInfo(asset, async () => metadata("f".repeat(64))));
});
