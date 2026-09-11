"use strict";

// From winbolo_parser: node tools/compare-base-generation.cjs [winbolo_log_directory ...]
// Requires the sibling ancient_bolo_parser checkout. Writes the evidence JSON in docs/corpus_runs.
// Rates use parser ticks (50/s), not elapsed wall time or the official viewer clock.

let fs = require("fs");
let path = require("path");
let { pathToFileURL } = require("url");
let { homedir } = require("os");

// Default replay directories to scan. Command-line directories replace this list.
const DEFAULT_WIN_LOG_DIRS = [
	path.join(homedir(), "Desktop/WinBolo logs"),
	path.join(homedir(), "AppData/Roaming/WinBolo/WinBolo/wbn_logs"),
];
let win_root = path.resolve(__dirname, "..");
let mac_root = path.resolve(win_root, "../ancient_bolo_parser");
let win_parser = require(path.join(win_root, "src/parse.js"));
let zip = require(path.join(win_root, "src/zip.js"));
let inflate = require(path.join(win_root, "src/inflate.js"));
const STOCKS = ["shells", "mines", "armour"];

function histogram(values) {
	let counts = new Map();
	for (let value of values) counts.set(value, (counts.get(value) || 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

async function measure_win(file) {
	let { log } = await win_parser.open_archive(new Uint8Array(fs.readFileSync(file)), zip, inflate);
	let bases = [], players = new Set(), snapshot_index = 0;
	let rises = [], deltas = [], lifecycle = [], batches = new Map();
	let chains = new Map(), quiet_growth = {}, quiet_growth_by_players = {}, snapshot_checks = 0, snapshot_mismatches = 0;
	for (let e of log.events) {
		while (snapshot_index < log.snapshots.length && log.snapshots[snapshot_index].tick <= e.tick) {
			let s = log.snapshots[snapshot_index++];
			for (let i = 0; i < s.bases.length; i++) for (let k of STOCKS) {
				if (!bases[i]) continue;
				snapshot_checks++;
				if (bases[i][k] !== s.bases[i][k]) {
					snapshot_mismatches++;
					chains.delete(`${i}:${k}`);
				}
			}
			bases = s.bases.map(b => ({ ...b }));
			players = new Set(s.players.filter(p => p.in_use).map(p => p.slot));
		}
		if (e.name === "PlayerJoined" || e.name === "PlayerRejoin") players.add(e.player);
		if (e.name === "PlayerQuit") players.delete(e.player);
		if (/Lobby|PlayerJoined|PlayerQuit|Spectator|Countdown/.test(e.name) && e.name !== "SpectatorChat") lifecycle.push({ tick: e.tick, name: e.name, player: e.player });
		if (e.name === "BaseSetOwner") for (let k of STOCKS) chains.delete(`${e.base}:${k}`);
		if (e.name !== "BaseSetStock") continue;
		let batch = batches.get(e.tick) || { tick: e.tick, players: players.size, bases: new Map(), total_bases: bases.length };
		batch.bases.set(e.base, (batch.bases.get(e.base) || 0) + 1);
		batches.set(e.tick, batch);
		let b = bases[e.base];
		if (b) {
			let delta = STOCKS.map(k => e[k] - b[k]);
			for (let k of STOCKS) {
				let key = `${e.base}:${k}`;
				if (e[k] < b[k] || e[k] >= 90) chains.delete(key);
				else if (e[k] > b[k]) {
					let chain = chains.get(key);
					if (!chain || chain.players !== players.size) {
						chain = { base: e.base, players: players.size, start_tick: e.tick, start_stock: e[k] };
						chains.set(key, chain);
					}
					let duration = e.tick - chain.start_tick;
					if (duration > (quiet_growth[k]?.duration_ticks || 0)) quiet_growth[k] = {
						...chain, end_tick: e.tick, end_stock: e[k], duration_ticks: duration,
						units_per_minute: (e[k] - chain.start_stock) * 3000 / duration
					};
					let by_players = quiet_growth_by_players[players.size] ||= {};
					if (duration > (by_players[k]?.duration_ticks || 0)) by_players[k] = {
						...chain, end_tick: e.tick, end_stock: e[k], duration_ticks: duration,
						units_per_minute: (e[k] - chain.start_stock) * 3000 / duration
					};
				}
			}
			if (delta.some(d => d > 0)) {
				rises.push({ tick: e.tick, base: e.base, players: players.size, delta });
				deltas.push(delta.join(","));
			}
		}
		bases[e.base] = { ...e };
	}
	let groups = {};
	for (let r of rises) {
		let g = groups[r.players] ||= { times: new Set(), gaps: [], last: new Map(), count: 0 };
		g.times.add(r.tick);
		if (g.last.has(r.base)) g.gaps.push(r.tick - g.last.get(r.base));
		g.last.set(r.base, r.tick);
		g.count++;
	}
	// Count complete passes, including multiple passes on one tick. A coincident
	// drain only adds an event to its own base, so it cannot add a complete pass.
	let global_updates = [...batches.values()].filter(b => b.bases.size === b.total_bases && b.total_bases > 1)
		.flatMap(b => Array.from({ length: Math.min(...b.bases.values()) }, () => b));
	let global_gaps = global_updates.slice(1).map((b, i) => b.tick - global_updates[i].tick);
	let cycle_candidates = [];
	for (let pulses = 1; pulses <= 16; pulses++) {
		let gaps = global_updates.slice(pulses).map((b, i) => b.tick - global_updates[i].tick);
		let matches = gaps.filter(g => g >= 990 && g <= 1010).length;
		if (matches > gaps.length / 2) cycle_candidates.push({ pulses_per_1000_ticks: pulses, matches, intervals: gaps.length, gap_histogram: histogram(gaps) });
	}
	let map_changes = log.events.filter(e => e.name === "MessageServer" && /^Map changed to /i.test(e.text)).map(e => ({ tick: e.tick, text: e.text }));
	let start_tick = log.events.find(e => e.name === "LobbyExit")?.tick ?? 0;
	let played_map = map_changes.filter(e => e.tick <= start_tick).at(-1)?.text.replace(/^Map changed to /i, "") || log.header.map_name;
	let roster_segments = [];
	for (let pulse of global_updates) {
		let segment = roster_segments.at(-1);
		if (!segment || segment.players !== pulse.players) {
			segment = { players: pulse.players, first_tick: pulse.tick, last_tick: pulse.tick, pulses: 0 };
			roster_segments.push(segment);
		}
		segment.last_tick = pulse.tick;
		segment.pulses++;
	}
	return { file: path.basename(file), server_created: log.header.created, map: log.header.map_name, played_map, start_tick, map_changes, roster_segments, version: log.header.bolo_version, ticks: log.ticks, warnings: log.warnings,
		quiet_growth, quiet_growth_by_players, snapshot_checks, snapshot_mismatches, cycle_candidates,
		global_updates: global_updates.map(({ tick, players }) => ({ tick, players })), global_gap_histogram: histogram(global_gaps),
		lifecycle, delta_histogram: histogram(deltas), first_rises: rises.slice(0, 25),
		groups: Object.fromEntries(Object.entries(groups).map(([n, g]) => [n, { count: g.count, distinct_ticks: g.times.size, gap_histogram: histogram(g.gaps) }])) };
}

async function measure_mac(file) {
	let { records } = await import(pathToFileURL(path.join(mac_root, "src/parse.js")));
	let times = new Map(), gaps = [], count = 0;
	for (let r of records(new Uint8Array(fs.readFileSync(file)))) {
		if (!r.subpackets.some(s => s.type === "base_stock_tick")) continue;
		if (times.has(r.player)) gaps.push(r.time - times.get(r.player));
		times.set(r.player, r.time);
		count++;
	}
	let regular_gaps = gaps.filter(g => g >= 900 && g <= 1100).sort((a, b) => a - b);
	return { file: path.basename(file), senders: times.size, stock_ticks: count, intervals: gaps.length,
		regular_intervals: regular_gaps.length, median_regular_gap: regular_gaps[Math.floor(regular_gaps.length / 2)], gap_histogram: histogram(gaps) };
}

async function main() {
	let win_dirs = process.argv.slice(2);
	if (!win_dirs.length) win_dirs = DEFAULT_WIN_LOG_DIRS;
	let win = [], failures = [], seen = new Map();
	let files = win_dirs.flatMap(dir => fs.readdirSync(dir).filter(n => n.endsWith(".wbv")).map(n => path.join(dir, n)));
	files.push(path.join(win_root, "samples/smol_war.wbv"));
	for (let file of files) {
		let sha256 = require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		if (seen.has(sha256)) { seen.get(sha256).duplicates.push(path.basename(file)); continue; }
		try {
			let result = await measure_win(file);
			result.sha256 = sha256;
			result.duplicates = [];
			seen.set(sha256, result);
			win.push(result);
		} catch (error) { failures.push({ file: path.basename(file), error: error.message }); }
	}
	let mac = [];
	let fixtures = path.join(mac_root, "fixtures");
	for (let name of fs.readdirSync(fixtures)) if (fs.statSync(path.join(fixtures, name)).isFile()) mac.push(await measure_mac(path.join(fixtures, name)));
	let output = JSON.stringify({ win, mac, failures }, null, "\t") + "\n";
	fs.writeFileSync(path.resolve(__dirname, "../docs/corpus_runs/base-generation-comparison.json"), output);
	for (let w of win) console.log(JSON.stringify({ file: w.file, map: w.played_map, version: w.version, cycles: w.cycle_candidates.map(c => c.pulses_per_1000_ticks), players: w.roster_segments.map(s => s.players), growth: Object.fromEntries(Object.entries(w.quiet_growth).map(([k, v]) => [k, [v.players, +v.units_per_minute.toFixed(3)]])), duplicates: w.duplicates, warnings: w.warnings }));
	console.log(JSON.stringify({ mac, failures }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
