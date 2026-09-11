"use strict";

// Read-only analysis of the controlled join/quit experiments.
// From winbolo_parser: node tools/measure-base-experiment.cjs [log_directory]
let fs = require("fs");
let path = require("path");
let { homedir } = require("os");
const DEFAULT_LOG_DIR = path.join(homedir(), "Desktop/testlog");
const STOCKS = ["shells", "mines", "armour"];
let parser = require("../src/parse.js");
let zip = require("../src/zip.js");
let inflate = require("../src/inflate.js");

async function measure(file) {
	let bytes = fs.readFileSync(file);
	let { log } = await parser.open_archive(new Uint8Array(bytes), zip, inflate);
	let bases = [], snapshot_index = 0, checks = 0, mismatches = 0;
	let batches = new Map(), transitions = [], players = new Set();
	let positive_changes = 0;
	for (let e of log.events) {
		while (snapshot_index < log.snapshots.length && log.snapshots[snapshot_index].tick <= e.tick) {
			let s = log.snapshots[snapshot_index++];
			for (let i = 0; i < s.bases.length; i++) for (let k of STOCKS) {
				if (!bases[i]) continue;
				checks++;
				if (bases[i][k] !== s.bases[i][k]) mismatches++;
			}
			bases = s.bases.map(b => ({ ...b }));
		}
		if (e.name === "PlayerJoined") players.add(e.player);
		if (e.name === "PlayerQuit") players.delete(e.player);
		if (["PlayerJoined", "PlayerQuit", "LobbyEnter", "LobbyExit"].includes(e.name)) {
			transitions.push({ tick: e.tick, event: e.name, slot: e.player, players: players.size });
		}
		if (e.name !== "BaseSetStock") continue;
		let batch = batches.get(e.tick) || { tick: e.tick, counts: new Map(), base_count: bases.length };
		batch.counts.set(e.base, (batch.counts.get(e.base) || 0) + 1);
		batches.set(e.tick, batch);
		if (bases[e.base] && STOCKS.some(k => e[k] > bases[e.base][k])) positive_changes++;
		bases[e.base] = { ...e };
	}
	let pulses = [...batches.values()].filter(b => b.base_count > 1 && b.counts.size === b.base_count)
		.flatMap(b => Array(Math.min(...b.counts.values())).fill(b.tick));
	let segments = transitions.map((event, index) => {
		let end = transitions[index + 1]?.tick ?? log.ticks;
		let times = pulses.filter(t => t >= event.tick && t < end);
		let candidates = [];
		for (let n = 1; n <= 16; n++) {
			let gaps = times.slice(n).map((t, i) => t - times[i]);
			let matches = gaps.filter(g => g >= 990 && g <= 1010).length;
			if (gaps.length >= 2 && matches >= gaps.length * 0.75) candidates.push({
				pulses_per_1000_ticks: n, nominal_units_per_minute: n * 3,
				matches, intervals: gaps.length, min_ticks: Math.min(...gaps), max_ticks: Math.max(...gaps)
			});
		}
		return { ...event, end_tick: end, pulse_count: times.length, candidates };
	}).filter(s => s.end_tick > s.tick);
	return {
		file: path.basename(file), sha256: require("crypto").createHash("sha256").update(bytes).digest("hex"),
		version: log.header.bolo_version, server_created: log.header.created, ticks: log.ticks,
		warnings: log.warnings, snapshot_checks: checks, snapshot_mismatches: mismatches,
		positive_stock_events: positive_changes, transitions, segments, pulse_ticks: pulses
	};
}

async function main() {
	let directory = process.argv[2] || DEFAULT_LOG_DIR;
	let results = [];
	for (let name of fs.readdirSync(directory).filter(n => n.endsWith(".wbv")).sort()) {
		results.push(await measure(path.join(directory, name)));
	}
	console.log(JSON.stringify(results, null, "\t"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
