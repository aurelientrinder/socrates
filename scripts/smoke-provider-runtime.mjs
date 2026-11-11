/**
 * OFFLINE Gemini SDK initialization gate (no generation or provider calls).
 * Loads the packaged @google/genai from the standalone payload and constructs
 * GoogleGenAI with a dummy key; the network is closed throughout.
 * All file modules must resolve inside the payload, including nested dependencies.
 *
 * node scripts/smoke-provider-runtime.mjs [--standalone <dir>] [--runtime <Node/Electron>]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

export function verifyProviderRuntime(standalone, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-runtime-"));
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone)], {
			cwd: home,
			env: { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`provider runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		assert.match(result.stdout, /Gemini SDK initialization passed/, "probe exited without success marker");
		process.stdout.write(result.stdout);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// Dedicated child only: nothing delegates to a live transport, even if the SDK
// changes its fetch path. Count attempts as well: a swallowed guard error fails.
function closeNetwork() {
	let attempts = 0;
	const deny = () => { attempts++; throw new Error("OFFLINE provider gate: network forbidden"); };
	globalThis.fetch = deny;
	globalThis.WebSocket = class { constructor() { deny(); } };
	const require = createRequire(import.meta.url);
	for (const [name, methods] of [
		["http", ["request", "get"]], ["https", ["request", "get"]],
		["net", ["connect", "createConnection"]], ["tls", ["connect"]],
		["dgram", ["createSocket"]],
		["dns", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
		["dns/promises", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
	]) {
		const module = require(`node:${name}`);
		for (const method of methods) module[method] = deny;
	}
	require("node:net").Socket.prototype.connect = deny;
	syncBuiltinESMExports();
	return () => assert.equal(attempts, 0, "SDK attempted network access");
}

async function probe(standalone) {
	const noNetwork = closeNetwork();
	const root = fs.realpathSync(standalone);
	const inside = (file) => {
		const relative = path.relative(root, fs.realpathSync(file));
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`dependency escaped standalone payload: ${file}`);
	};
	const loaded = new Set();
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				inside(fileURLToPath(result.url));
				loaded.add(fileURLToPath(result.url));
			} else assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			return result;
		},
	});
	try {
		// The SDK is an explicit server external: import the payload's copy,
		// never the checkout's module.
		const sdkRoot = path.join(root, "node_modules/@google/genai");
		const manifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
		const entry = pathToFileURL(path.join(sdkRoot, manifest.exports?.["."]?.node?.import ?? manifest.exports?.["."]?.import ?? manifest.module ?? manifest.main));
		const { GoogleGenAI } = await import(entry.href);
		const client = new GoogleGenAI({ apiKey: "dummy-offline-provider-gate-not-a-key" });
		assert.equal(typeof client.models.generateContentStream, "function", "SDK client missing generateContentStream");
		assert.equal(typeof client.models.list, "function", "SDK client missing models.list");
		noNetwork();
		// Resolution/evaluation, not folder-exists checks. This also covers the
		// previously missing transitive edge and permits legitimate nested deps.
		for (const name of ["@google/genai", "google-auth-library", "gcp-metadata", "json-bigint", "bignumber.js"]) {
			assert.ok([...loaded].some((file) => file.includes(`${path.sep}node_modules${path.sep}${name.replaceAll("/", path.sep)}${path.sep}`)),
				`Google runtime chain was not loaded: ${name}`);
		}
		console.log(`[smoke-provider-runtime] Gemini SDK initialization passed; ${loaded.size} modules confined to ${root}; zero network attempts`);
	} finally { hooks.deregister(); }
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--probe") return probe(args[1]);
	const value = (name, fallback) => {
		const index = args.indexOf(name);
		if (index < 0) return fallback;
		assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
		return path.resolve(args[index + 1]);
	};
	verifyProviderRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`[smoke-provider-runtime] FAIL: ${formatProbeError(error)}`); process.exitCode = 1; });
}
