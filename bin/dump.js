#!/usr/bin/env node
/* Command-line dump of a WinBolo replay (.wbv, or a bare log.dat).
 *
 *   node bin/dump.js <replay>              summary
 *   node bin/dump.js <replay> --events     every event, one per line
 *   node bin/dump.js <replay> --chat       messages and player comings and goings
 *   node bin/dump.js <replay> --json       one JSON object per event
 *   node bin/dump.js <replay> --snapshots  the state snapshots
 *   node bin/dump.js <replay> --attribution  the attribution.trk records */
"use strict";
const fs = require("fs");
const path = require("path");
const zip = require(path.join(__dirname, "..", "src", "zip.js"));
const inflate = require(path.join(__dirname, "..", "src", "inflate.js"));
const WinBoloLog = require(path.join(__dirname, "..", "src", "parse.js"));

const TPS = WinBoloLog.TICKS_PER_SECOND;

function usage() {
	console.error("usage: node bin/dump.js <replay> [--events | --chat | --json | --snapshots | --attribution]");
	process.exit(2);
}

function fmt_time(tick) {
	let s = Math.floor(tick / TPS);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* An event as one line: its fields after tick, type and name. */
function describe(e) {
	let parts = [];
	for (let k in e) {
		if (k === "tick" || k === "type" || k === "name") continue;
		let v = e[k];
		parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? v.join(",") : v}`);
	}
	return parts.join(" ");
}

async function main() {
	let args = process.argv.slice(2);
	let file = args.find(a => !a.startsWith("--"));
	let mode = args.find(a => a.startsWith("--")) || "--summary";
	if (!file) usage();
	let bytes = new Uint8Array(fs.readFileSync(file));
	let { log, attribution, members } = await WinBoloLog.open_archive(bytes, zip, inflate);
	let h = log.header;

	if (mode === "--json") {
		for (let e of log.events) process.stdout.write(JSON.stringify(e) + "\n");
		return;
	}
	if (mode === "--events") {
		for (let e of log.events) console.log(`${fmt_time(e.tick)} ${String(e.tick).padStart(7)} ${e.name} ${describe(e)}`);
		return;
	}
	if (mode === "--snapshots") {
		for (let s of log.snapshots) {
			let grid = WinBoloLog.snapshot_grid(s);
			let land = 0;
			for (let i = 0; i < grid.length; i++) if (grid[i] !== WinBoloLog.DEEP_SEA) land++;
			let players = s.players.filter(p => p.in_use).map(p => `${p.slot}:${p.name}`).join(" ");
			console.log(`${fmt_time(s.tick)} tick ${s.tick} offset ${s.offset}: ${s.pills.length} pills, ${s.bases.length} bases, ` +
				`${s.starts.length} starts, ${land} land squares, game length ${s.game_length === 0 || s.game_length === 0xffffffff ? "unlimited" : s.game_length + " ms"}; ${players}`);
		}
		return;
	}
	if (mode === "--attribution") {
		if (!attribution) {
			console.log("no attribution.trk in this archive");
			return;
		}
		console.log(`version ${attribution.version}${attribution.truncated ? ", truncated" : ""}, ${attribution.count} records`);
		for (let p of attribution.players) if (p.name) console.log(`slot ${p.slot} team ${p.team}${p.bot ? " bot" : ""} ${p.name}`);
		for (let r of attribution.records) {
			let { tick, type, name, ...fields } = r;
			console.log(`${tick} ${name} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
		}
		return;
	}
	if (mode === "--chat") {
		let names = Array(16).fill(null);
		let who = p => names[p] || `player ${p}`;
		for (let e of log.events) {
			let line = null;
			switch (e.name) {
				case "PlayerJoined": names[e.player] = e.player_name; line = `⚑ ${e.player_name} joined${e.country ? " (" + e.country + ")" : ""}`; break;
				case "ChangeName": line = `⇄ ${who(e.player)} is now ${e.player_name}`; names[e.player] = e.player_name; break;
				case "PlayerQuit": line = `✝ ${who(e.player)} left the game`; break;
				case "MessageServer": line = `server: ${e.text}`; break;
				case "MessageAll": line = `${who(e.player)}: ${e.text}`; break;
				case "MessagePlayers": line = `${who(e.player)} (to ${who(e.to)}): ${e.text}`; break;
				case "KillPlayer": line = e.killer === e.player ? `${who(e.player)} drowned` : `${e.killer === WinBoloLog.NEUTRAL ? "a pillbox" : who(e.killer)} killed ${who(e.player)}`; break;
				case "PlayerDied": line = `${who(e.player)} died`; break;
				case "AllyAccept": line = `${who(e.player)} allied with ${who(e.other)}`; break;
				case "AllyLeave": line = `${who(e.player)} left the alliance`; break;
				case "VoteCalled": line = `${who(e.player)} called a vote to ${WinBoloLog.VOTE_KINDS[e.kind] || "kind " + e.kind}`; break;
				case "VoteCast": line = `${who(e.player)} voted ${e.vote ? "yes" : "no"}`; break;
				case "VoteResult": line = `vote to ${WinBoloLog.VOTE_KINDS[e.kind] || "kind " + e.kind} ${e.passed ? "passed" : "failed"}`; break;
			}
			if (line) console.log(`${fmt_time(e.tick)} ${line}`);
		}
		return;
	}
	if (mode !== "--summary") usage();

	console.log(`${file}: ${members.join(", ")}`);
	console.log(`log version ${h.version}, WinBolo ${h.bolo_version}, map "${h.map_name}"`);
	console.log(`game type ${WinBoloLog.GAME_TYPES[h.game_type] || h.game_type}, hidden mines ${h.hidden_mines}, ` +
		`AI ${h.ai}, password ${h.password}, max players ${h.max_players}`);
	console.log(`server ${h.server_ip}:${h.server_port}, created ${new Date(h.created * 1000).toISOString()}, WBN key ${h.wbn_key}`);
	console.log(`${log.ticks} ticks (${fmt_time(log.ticks)} at ${TPS}/s), ${log.events.length} events, ${log.snapshots.length} snapshots, ` +
		`${log.finished ? "complete" : "cut off"}`);
	let counts = {};
	for (let e of log.events) counts[e.name] = (counts[e.name] || 0) + 1;
	for (let name of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
		console.log(`  ${String(counts[name]).padStart(8)}  ${name}`);
	}
	for (let w of log.warnings) console.log(`warning: ${w}`);
	if (attribution) console.log(`attribution.trk: ${attribution.records.length} records${attribution.complete ? "" : " (count mismatch)"}`);
}

main().catch(err => {
	console.error(String(err.message || err));
	process.exit(1);
});
