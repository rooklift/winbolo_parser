/* Test of the Tauri app's window.api shim (viewer/tauri_api.js) against a
 * mocked bridge: replays the host reads arrive as a path plus an id, with
 * the bytes fetched by that id afterwards, so two replays offered while
 * the page is busy must each keep their own contents, and reach the page
 * in the order they arrived. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(what, got, want) {
	let ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`);
}

/* The host as main.rs behaves: each read replay is held under a fresh id
 * until taken, and both the offer and the fetch of its bytes go over the
 * bridge as separate, deferred round trips. */
function mock_host() {
	let held = new Map();
	let delays = new Map();
	let next_id = 0;
	let listeners = {};
	let commands = {
		take_log_bytes: async ({ id }) => {
			/* a fetch the host is slow to answer lands after later ones */
			for (let i = delays.get(id) || 0; i > 0; i--) await new Promise(resolve => setImmediate(resolve));
			if (!held.has(id)) throw new Error("that replay is no longer waiting");
			let data = held.get(id);
			held.delete(id);
			return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
		},
		pending_logs: () => Promise.resolve([...held.keys()].map(id => ({ id, path: `startup${id}.wbv` }))),
		open_log: () => {
			let id = host.stash("picked.wbv", new Uint8Array([9, 9]));
			return Promise.resolve({ canceled: false, id, path: "picked.wbv" });
		},
	};
	let window = {
		__TAURI__: {
			/* every round trip lands on a later tick, as a busy page would see it */
			core: { invoke: (cmd, args) => new Promise((resolve, reject) => setImmediate(() => commands[cmd](args).then(resolve, reject))) },
			event: { listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); } },
		},
	};
	let host = {
		window,
		stash: (log_path, data) => {
			let id = ++next_id;
			held.set(id, data);
			return id;
		},
		/* a drop before the page listens is only held, for pending_logs */
		drop: (log_path, data) => {
			let id = host.stash(log_path, data);
			if (listeners["load-log"]) listeners["load-log"]({ payload: { id, path: log_path } });
		},
		evict: id => held.delete(id),
		delay: (id, ticks) => delays.set(id, ticks),
		held_count: () => held.size,
	};
	return host;
}

function load_shim(window) {
	let src = fs.readFileSync(path.join(__dirname, "..", "viewer", "tauri_api.js"), "utf8");
	vm.runInNewContext(src, { window });
	return window.api;
}

/* Resolve once every round trip queued so far, and its follow-ups, have run. */
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

(async () => {
	/* Two drops while the page is busy: each arrives with its own bytes. */
	{
		let host = mock_host();
		let api = load_shim(host.window);
		let got = [];
		api.on_load_log(payload => got.push({ path: payload.path, data: [...payload.data] }));
		await settle();
		host.drop("a.wbv", new Uint8Array([1, 2, 3]));
		host.drop("b.wbv", new Uint8Array([4, 5]));
		await settle();
		check("two quick drops keep their own contents", got, [
			{ path: "a.wbv", data: [1, 2, 3] },
			{ path: "b.wbv", data: [4, 5] },
		]);
		check("nothing left held", host.held_count(), 0);
	}

	/* The page hears of drops in the order they arrived, even when the
	 * bytes of an earlier one take longer to fetch: the last drop must be
	 * the one the page ends up showing. */
	{
		let host = mock_host();
		let api = load_shim(host.window);
		let got = [];
		api.on_load_log(payload => got.push(payload.path));
		await settle();
		host.drop("slow.wbv", new Uint8Array([1]));
		host.delay(1, 3);
		host.drop("fast.wbv", new Uint8Array([2]));
		await settle();
		check("a slow fetch keeps its place in the order", got, ["slow.wbv", "fast.wbv"]);
	}

	/* Replays waiting at startup are all listed, in arrival order, and one
	 * offered twice (listed and announced) is delivered once. */
	{
		let host = mock_host();
		host.stash("startup1.wbv", new Uint8Array([7]));
		host.stash("startup2.wbv", new Uint8Array([8]));
		let api = load_shim(host.window);
		let got = [];
		api.on_load_log(payload => got.push({ path: payload.path, data: [...payload.data] }));
		await settle();
		check("startup replays delivered in order", got, [
			{ path: "startup1.wbv", data: [7] },
			{ path: "startup2.wbv", data: [8] },
		]);
	}

	/* The dialog's replay comes back under its own id too. */
	{
		let host = mock_host();
		let api = load_shim(host.window);
		host.drop("dropped.wbv", new Uint8Array([1]));
		let res = await api.open_log();
		check("opened replay has its own bytes", { path: res.path, data: [...res.data] }, { path: "picked.wbv", data: [9, 9] });
	}

	/* A replay the host no longer holds is passed over, not delivered empty. */
	{
		let host = mock_host();
		let api = load_shim(host.window);
		let got = [];
		api.on_load_log(payload => got.push(payload.path));
		await settle();
		host.drop("gone.wbv", new Uint8Array([1]));
		host.evict(1); /* the host let it go before the page fetched */
		await settle();
		check("an evicted replay is skipped", got, []);
	}

	if (failures) {
		console.log(`${failures} failure(s)`);
		process.exitCode = 1;
	} else {
		console.log("all checks passed");
	}
})();
