/* Tests: the zip reader and the log parser against a synthetic archive
 * (built here with Node's zlib, so nothing private is committed), the
 * replay engine on it, the viewer build's freshness, and, when a real
 * replay sits in samples/ (gitignored), a full parse of that. */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");

const root = path.join(__dirname, "..");
const zip = require(path.join(root, "src", "zip.js"));
const inflate = require(path.join(root, "src", "inflate.js"));
const WinBoloLog = require(path.join(root, "src", "parse.js"));
const WinBoloGame = require(path.join(root, "viewer", "game.js"));
const { build } = require(path.join(root, "tools", "build-viewer-parser.js"));

let failures = 0;
function check(what, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

/* ---------- a synthetic log.dat ---------- */

function pstr(s) { return [s.length, ...Buffer.from(s, "latin1")]; }
function be16(n) { return [(n >> 8) & 255, n & 255]; }
function be32(n) { return [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function event(type, payload) { return [type, ...be16(payload.length), ...payload]; }
function block(events) { return [3, events.length, ...events.flat()]; }

/* a 4×2 patch of land at (100,100): grass, road, road, forest / building… */
function runs() {
	/* row 100: literal code 3 = 4 squares: grass(7) road(4) road(4) forest(5) */
	let row0 = [4 + 3, 100, 100, 104, 0x37, 0x44, 0x50];
	/* row 101: repeat code 9 = 3 squares of building(0), then 1 literal river(1) */
	let row1 = [4 + 2, 101, 100, 104, 0x90, 0x01];
	return [...row0, ...row1, 4, 0xff, 0xff, 0xff];
}

function snapshot() {
	let pills = [1, 101, 102, 15, 0xff, 50, 0, 0, 0, 0]; /* off the shells' row */
	let bases = [1, 102, 100, 0xff, 90, 90, 90, 0, 0, 0, 0];
	let starts = [1, 100, 100, 4];
	let players = [];
	for (let i = 0; i < 16; i++) {
		if (i === 0) {
			let rec = [0, 1, 100, 100, 0x88, 4 + 16, 1, 0, 0, 0, 0, ...pstr("Alice"), ...pstr("GB"), 0];
			players.push(rec.length, ...rec);
		} else {
			players.push(2, i, 0);
		}
	}
	return [5, ...be32(0), ...be32(0xffffffff), pills.length, ...pills, bases.length, ...bases, starts.length, ...starts, ...runs(), ...players];
}

/* A shell from (x, y) heading dir for n ticks, then its burst on Alice's
 * tank at (100.5, 100.5), her boat flag dropping, and her drowning a tick
 * later. */
function boat_shell(tick0, x, y, dir, n) {
	let out = [];
	let hx = Math.sin(dir / 16 * 2 * Math.PI), hy = -Math.cos(dir / 16 * 2 * Math.PI);
	let pos = (v) => { let m = Math.floor(v), p = Math.round((v - m) * 16); if (p === 16) { m++; p = 0; } return [m, p]; };
	for (let i = 0; i < n; i++) {
		let [mx, px] = pos(x), [my, py] = pos(y);
		out.push(...block([event(6, [mx, my, (px << 4) | py, 9 + dir])]));
		x += hx / 8; y += hy / 8;
	}
	x += hx / 8; y += hy / 8; /* the fatal step */
	let [mx, px] = pos(x - 0.5), [my, py] = pos(y - 0.5); /* burst corner */
	out.push(...block([event(6, [mx, my, (px << 4) | py, 8]), event(3, [0, 100, 100, 0x88, 0x40])])); /* tick0+17: burst on her; boat flag drops */
	out.push(...block([event(33, [0, 0]), event(36, [0]), event(3, [0, 0, 0, 0, 0x40])]));           /* tick0+18: killed by herself */
	return out;
}

/* An attribution.trk with two named slots and one record of three kinds. */
function synthetic_attribution() {
	let le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
	let slot = (bot, team, name) => [bot, team, ...Buffer.from(name.padEnd(64, "\0"))];
	let head = [...Buffer.from("WBAT"), 2, 0, 16, 0];
	for (let i = 0; i < 16; i++) head.push(...(i === 0 ? slot(0, 1, "Alice") : i === 1 ? slot(1, 2, "Bob") : slot(0, 0, "")));
	head.push(...le32(3));
	let records = [
		1, ...le32(300), 1, 1, 0, 1, 2, 1, 1, 101, 102,   /* damage: a shell from Bob takes pill 0 to zero at 101,102 */
		2, ...le32(65536), 255, 0, 2, 0, 0, 100, 100,    /* kill: Alice, by no one */
		5, ...le32(400), 0, 2, 100, 100,                 /* action: Alice lays a mine */
	];
	return Uint8Array.from([...head, ...records]);
}

function synthetic_log() {
	let header = [...Buffer.from("WBOLOMOV"), 2, ...pstr("Test Map"), 3, 0, 0, 0, 16, 2, 0, 3,
		0, 0, 0, 0, 0, 0, ...be32(1700000000), ...Buffer.from("0123456789abcdef0123456789abcdef")];
	let body = [
		...snapshot(),
		...block([event(1, [0, 0x47, 0x42, 0, 0, ...pstr("Alice")])]),          /* tick 0: Alice joins */
		...block([event(39, [0]), event(42, [])]),                               /* tick 1: ready, countdown */
		1, 9,                                                                    /* 9 empty ticks */
		...block([event(38, []),                                                 /* tick 11: game start */
			event(1, [1, 0x55, 0x53, 0, 0, ...pstr("Bob")]),
			event(3, [0, 100, 100, 0x88, 0x41]),                                 /* Alice's tank east, on a boat */
			event(19, [0, ...pstr("hi")])]),
		2, 0, 1,                                                                 /* 256 empty ticks (a little-endian count) */
		...block([event(4, [0x02, 101, 100, 0x84]),                              /* tick 268: Alice's man out, frame 2 */
			event(6, [101, 100, 0x88, 9 + 4]),                                   /* a shell flying east */
			event(6, [102, 100, 0x88, 8]),                                       /* a fresh explosion */
			event(5, [103, 100, 3]),                                             /* forest becomes crater */
			event(28, [0x0c]),                                                   /* pill 0 armour 12 */
			event(27, [0, 0, 1]),                                                /* pill 0 to Alice */
			event(25, [0, 1, 0]),                                                /* base 0 to Bob */
			event(33, [1, 0]),                                                   /* Alice kills Bob */
			event(99, [1, 2, 3])]),                                              /* an unknown event, skipped */
		...block([event(32, [0]), event(2, [1])]),                               /* tick 269: Alice loses her man; Bob quits */
		2, 255, 0,                                                               /* 255 empty ticks (a little-endian count) */
		/* ticks 525-527: a shell flies east along row 100 from Alice's tank at
		 * (100.5, 100.5), then a gap tick, then a burst a step on with nothing
		 * hit: a fall (its corner pixel is not the square's origin) */
		...block([event(6, [101, 100, 0x28, 9 + 4])]),                           /* 101.125, 100.5 */
		...block([event(6, [101, 100, 0x48, 9 + 4])]),                           /* 101.25 */
		...block([event(6, [101, 100, 0x68, 9 + 4])]),                           /* 101.375 */
		1, 1,                                                                    /* the gap tick */
		...block([event(6, [101, 100, 0x40, 8])]),                               /* tick 529: burst corner 101.25,100.0: centre 101.75,100.5 */
		...block([event(6, [101, 100, 0x40, 8])]),                               /* tick 530: the burst's second tick */
		...block([event(6, [101, 100, 0x40, 7])]),                               /* tick 531: stage 7 */
		/* ticks 532-538: another shell along the row, then a burst snapped to the
		 * centre of square 102,100 as the forest there becomes grass: a terrain hit */
		...[2, 4, 6, 8, 10, 12, 14].flatMap(px => block([event(6, [101, 100, (px << 4) | 8, 9 + 4])])),
		...block([event(6, [102, 100, 0x00, 8]), event(5, [102, 100, 7])]),      /* tick 539 */
		...block([event(33, [0, 0xff]), event(3, [0, 0, 0, 0, 0x40])]),          /* tick 540: a pillbox kills Alice; her tank is logged at 0,0 */
		...block([event(3, [0, 100, 100, 0x88, 0x40])]),                          /* tick 541: Alice respawns */
		...block([event(5, [100, 100, 12])]),                                    /* tick 542: a mine under her */
		...block([event(5, [100, 100, 3])]),                                     /* tick 543: it goes off */
		...block([event(3, [0, 0, 0, 0, 0x40])]),                                /* tick 544: her tank vanishes, no death logged */
		...block([event(3, [0, 100, 100, 0x88, 0x40])]),                          /* tick 545: Alice respawns */
		...block([event(33, [0, 0]), event(36, [0]),                             /* tick 546: and drowns (killed by herself), */
			event(6, [101, 100, 0x28, 9 + 4])]),                                 /* having fired east on her way out (101.125, 100.5) */
		/* ticks 547-565: Alice respawns on a boat at (100.5, 100.5); the pillbox at
		 * (101, 102) fires north-north-west, the shell reaches her, her boat flag
		 * drops in the same tick, and she is logged as killed by herself */
		...block([event(3, [0, 100, 100, 0x88, 0x41])]),                          /* tick 547: on a boat */
		...boat_shell(548, 101.5, 102.5, 15, 17),
		/* ticks 567-568: Alice's team message is logged once per recipient */
		...block([event(20, [0, 0, ...pstr("push")])]),
		...block([event(20, [0, 1, ...pstr("push")]), event(20, [0, 2, ...pstr("push")])]),
		/* a mid-game snapshot, with the one-tick no-events record the server
		 * writes after every snapshot: no tick passes in it */
		...snapshot(), 1, 1,
		/* ticks 569-594: Alice respawns on a boat again; a shell from nowhere
		 * (no tank or pillbox near (97.6, 100.5)) flies east and sinks her */
		...block([event(3, [0, 100, 100, 0x88, 0x41])]),                          /* tick 569: on a boat */
		...boat_shell(570, 97.6, 100.5, 4, 23),
		0, 0,
	];
	return Uint8Array.from([...header, ...body]);
}

/* A zip holding one deflated member, as the server writes .wbv files. */
function make_zip(members) {
	let local = [], central = [], offset = 0;
	let crc_of = b => zip.crc32(b);
	for (let [name, data] of members) {
		let comp = zlib.deflateRawSync(Buffer.from(data));
		let n = Buffer.from(name);
		let head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
		head.writeUInt32LE(crc_of(data), 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(n.length, 26);
		let cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
		cd.writeUInt32LE(crc_of(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
		local.push(head, n, comp);
		central.push(cd, n);
		offset += head.length + n.length + comp.length;
	}
	let cd_bytes = Buffer.concat(central);
	let comment = Buffer.from("WinBolo Log File");
	let end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
	end.writeUInt32LE(cd_bytes.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
	return new Uint8Array(Buffer.concat([...local, cd_bytes, end, comment]));
}

async function test_synthetic() {
	let log_bytes = synthetic_log();
	let archive = make_zip([["log.dat", log_bytes], ["attribution.trk", synthetic_attribution()]]);
	check("zip is recognised", zip.is_zip(archive));
	let entries = zip.entries(archive);
	check("zip has two members", entries.length === 2 && entries[0].name === "log.dat" && entries[1].name === "attribution.trk");
	check("zip comment", entries.comment === "WinBolo Log File");
	let inflated = await inflate.inflate_raw(entries[0].data);
	check("member inflates to the log", Buffer.compare(Buffer.from(inflated), Buffer.from(log_bytes)) === 0);

	let { log, attribution } = await WinBoloLog.open_archive(archive, zip, inflate);
	check("attribution header", attribution.version === 2 && !attribution.truncated && attribution.slots === 16 && attribution.count === 3 && attribution.complete, JSON.stringify(attribution));
	check("attribution slots", attribution.players[0].name === "Alice" && attribution.players[0].team === 1 && !attribution.players[0].bot && attribution.players[1].bot);
	check("attribution damage", JSON.stringify(attribution.records[0]) === JSON.stringify({ tick: 300, type: 1, name: "damage", source: "shell", target: "pill", target_index: 0, attacker: 1, amount: 258, destroyed: true, x: 101, y: 102 }), JSON.stringify(attribution.records[0]));
	check("attribution kill", attribution.records[1].name === "kill" && attribution.records[1].killer === 255 && attribution.records[1].killed === 0 && attribution.records[1].tick === 65536);
	check("attribution action", attribution.records[2].name === "action" && attribution.records[2].action === "lay_mine" && attribution.records[2].x === 100);
	let h = log.header;
	check("header map name", h.map_name === "Test Map");
	check("header bolo version", h.bolo_version === "2.0.3");
	check("header created", h.created === 1700000000);
	check("header max players", h.max_players === 16);
	check("tick count", log.ticks === 595, String(log.ticks));
	check("finished", log.finished && log.warnings.length === 0, log.warnings.join("; "));
	check("snapshot count", log.snapshots.length === 2);
	check("the no-events record after a snapshot takes no tick", log.snapshots[1].tick === 569 && log.events.some(e => e.tick === 569 && e.type === 3), String(log.snapshots[1].tick));
	let s = log.snapshots[0];
	check("snapshot pill", s.pills.length === 1 && s.pills[0].x === 101 && s.pills[0].owner === 0xff && s.pills[0].armour === 15);
	check("snapshot base", s.bases.length === 1 && s.bases[0].shells === 90);
	check("snapshot player", s.players[0].in_use && s.players[0].name === "Alice" && s.players[0].location === "GB" && s.players[0].tank.on_boat);
	check("snapshot slot 1 unused", !s.players[1].in_use);
	let grid = WinBoloLog.snapshot_grid(s);
	check("map run literals", grid[100 * 256 + 100] === 7 && grid[100 * 256 + 101] === 4 && grid[100 * 256 + 103] === 5);
	check("map run repeat", grid[101 * 256 + 100] === 0 && grid[101 * 256 + 102] === 0 && grid[101 * 256 + 103] === 1);
	check("map elsewhere is sea", grid[0] === 255 && grid[101 * 256 + 104] === 255);

	let ev = log.events;
	let names = ev.map(e => e.name);
	check("event names", names.slice(0, 18).join(",") === "PlayerJoined,PlayerReady,CountdownStart,LobbyExit,PlayerJoined,PlayerLocation,MessageAll,LgmLocation,Shell,Shell,MapChange,PillSetHealth,PillSetOwner,BaseSetOwner,KillPlayer,event_99,LostMan,PlayerQuit", names.join(","));
	ev = ev.filter(e => e.tick < 500); /* the shell-tracking tail is checked below */
	check("event ticks", ev.map(e => e.tick).join(",") === "0,1,1,11,11,11,11,268,268,268,268,268,268,268,268,268,269,269", ev.map(e => e.tick).join(","));
	check("ready decodes", ev[1].player === 0);
	ev = ev.filter(e => e.type < 37 || e.type > 42); /* the rest of the checks index the classic events */
	check("join decodes country", ev[0].player_name === "Alice" && ev[0].country === "GB" && ev[1].country === "US");
	check("tank location decodes", ev[2].mx === 100 && ev[2].px === 8 && ev[2].dir === 4 && ev[2].on_boat === true && ev[2].in_world);
	check("message decodes", ev[3].player === 0 && ev[3].text === "hi");
	check("lgm decodes", ev[4].player === 0 && ev[4].frame === 2 && ev[4].mx === 101 && ev[4].px === 8 && ev[4].py === 4);
	check("shell in flight", ev[5].dir === 4 && ev[5].explosion === undefined);
	check("shell explosion", ev[6].explosion === 8 && ev[6].dir === undefined);
	check("map change", ev[7].x === 103 && ev[7].terrain === 3);
	check("pill health nibbles", ev[8].pill === 0 && ev[8].armour === 12);
	check("pill owner", ev[9].pill === 0 && ev[9].owner === 0 && ev[9].migrate === true);
	check("base owner", ev[10].base === 0 && ev[10].owner === 1);
	check("kill", ev[11].player === 1 && ev[11].killer === 0);
	check("unknown event kept raw", ev[12].type === 99 && ev[12].raw.join(",") === "1,2,3");
	let pill_kill = log.events.find(e => e.tick === 540);
	check("pillbox kill", pill_kill.name === "KillPlayer" && pill_kill.player === 0 && pill_kill.killer === 0xff);

	let game = WinBoloGame.build(log);
	check("game length", game.t1 === 595);
	check("game starts at the marker", game.t0 === 11, String(game.t0));
	check("chat wire starts at the game", game.chat.map(m => m.kind).join(",") === "join,say,kill,lost_man,quit,pill_kill,mine_kill,drowned,boat_sunk,say,boat_sunk", game.chat.map(m => m.kind).join(","));
	check("a team message's copies fold into one line", game.chat[9].text === "push" && game.chat[9].tick === 567 && game.chat[9].to.join(",") === "0,1,2", JSON.stringify(game.chat[9]));
	check("the sunk boat names the pillbox", game.chat[8].sinker_name === "a pillbox" && game.chat[8].name === "Alice" && game.chat[8].tick === 566, JSON.stringify(game.chat[8]));
	check("a boat sunk by an unplaced shell names nobody", game.chat[10].sinker === null && game.chat[10].sinker_name === null && game.chat[10].name === "Alice" && game.chat[10].tick === 594, JSON.stringify(game.chat[10]));
	let parting_shot = log.events.find(e => e.tick === 546 && e.type === 6);
	check("a shell fired in the tick its tank dies is that tank's", parting_shot && parting_shot.owner === 0, JSON.stringify(parting_shot));
	check("an unlogged death under a mine is a mine kill", game.chat[6].name === "Alice" && game.chat[6].tick === 544);
	check("the unlogged death bursts", game.effects.some(e => e.type === "tank_death" && e.tick === 544 && Math.abs(e.x - 100.5) < 0.01));
	check("the tank is gone after it", !WinBoloGame.state_at(game, 544).state.players[0].tank.in_world);
	let lgm_death = game.effects.find(e => e.type === "lgm_death");
	check("the builder's death bursts where he last stood", lgm_death && lgm_death.tick === 269 && lgm_death.player === 0 && Math.abs(lgm_death.x - 101.5) < 0.01 && Math.abs(lgm_death.y - 100.25) < 0.01, JSON.stringify(lgm_death));
	check("pillbox kill names the victim", game.chat[5].name === "Alice");
	let dead = WinBoloGame.state_at(game, 540).state.players[0].tank;
	check("the pillbox kill removes Alice", !dead.in_world);
	check("a dead tank keeps where it died", dead.mx === 100 && dead.my === 100 && dead.died_at === 540, JSON.stringify(dead));
	check("kill names", game.chat[2].killer_name === "Alice" && game.chat[2].name === "Bob");
	check("server messages kept from the lobby", Array.isArray(game.server_messages));
	let no_marker = WinBoloLog.parse_log(log_bytes);
	no_marker.events = no_marker.events.filter(e => e.type !== 38);
	check("without a marker the game starts where the world is populated", WinBoloGame.game_start_tick(no_marker) === 0);
	check("land bounds", game.bounds && game.bounds.minx === 100 && game.bounds.maxx === 103 && game.bounds.maxy === 101);
	let { state } = WinBoloGame.state_at(game, 268);
	check("state at 268: pill", state.pills[0].armour === 12 && state.pills[0].owner === 0);
	check("state at 268: base", state.bases[0].owner === 1);
	check("state at 268: terrain", state.grid[100 * 256 + 103] === 3);
	check("state at 268: shells", state.shells.length === 2 && WinBoloGame.restated(state, 268));
	check("state at 268: man out", state.players[0].lgm.out && state.players[0].lgm.frame === 2);
	check("state at 268: Bob dead", !state.players[1].tank.in_world && state.players[1].in_use);
	check("state at 268: Alice alive", state.players[0].tank.in_world && state.players[0].tank.dir === 4);
	let later = WinBoloGame.state_at(game, 269).state;
	check("state at 269: Bob gone", later.players[1].quit && !later.players[1].in_use);
	check("state at 269: shells gone", later.shells.length === 0 && !later.players[0].lgm.out);
	let early = WinBoloGame.state_at(game, 5).state;
	check("state at 5: only Alice", early.players[0].in_use && !early.players[1].in_use && early.pills[0].armour === 15);
	check("next change from 11", WinBoloGame.adjacent_change_tick(game, 11, 1) === 268);
	check("previous change from 268", WinBoloGame.adjacent_change_tick(game, 268, -1) === 11);
	check("previous change stops at the start", WinBoloGame.adjacent_change_tick(game, 11, -1) === 11);
	check("team of unallied", WinBoloGame.team_of(state, 1) === 1);

	/* a bare log.dat, no zip */
	let bare = WinBoloLog.parse_log(log_bytes);
	check("bare log parses the same", bare.events.length === log.events.length && bare.ticks === 595);
	/* shell tracking: owners from muzzles, causes from consequences */
	let flights = log.events.filter(e => e.type === 6 && e.dir !== undefined && e.tick >= 525 && e.tick < 548);
	check("shell owner is the tank it left", flights.every(f => f.owner === 0), flights.map(f => f.owner).join(","));
	check("shell ages count up", flights.slice(0, 3).map(f => f.age).join(",") === "0,1,2");
	let bursts = log.events.filter(e => e.type === 6 && e.explosion !== undefined && e.tick >= 525);
	check("fall burst and its later stages are marked", bursts.slice(0, 3).every(b => b.cause === "fall" && b.owner === 0), bursts.slice(0, 3).map(b => b.cause).join(","));
	check("terrain hit is marked", bursts[3].cause === "terrain" && bursts[3].age === 6 && bursts[3].owner === 0, `${bursts[3].cause} ${bursts[3].age}`);
	check("fall segment recorded", game.fall_segments.length === 1 && game.fall_segments[0].start === 527 && game.fall_segments[0].end === 529);
	check("splash effect recorded", game.effects.some(e => e.type === "splash" && e.tick === 529 && Math.abs(e.x - 101.75) < 0.01 && Math.abs(e.y - 100.5) < 0.01));
	let mid = WinBoloGame.fall_positions_at(game, 528);
	check("falling shell drawn on through the gap", mid.length === 1 && Math.abs(mid[0].x - 101.5625) < 0.001 && mid[0].dir === 4, JSON.stringify(mid));
	check("nothing falling after the splash", WinBoloGame.fall_positions_at(game, 530).length === 0);
	check("the early burst at 268 is nobody's shell", log.events.find(e => e.type === 6 && e.explosion === 8 && e.tick === 268).cause === undefined);

	/* a truncated log is reported, not thrown */
	let cut = WinBoloLog.parse_log(log_bytes.subarray(0, log_bytes.length - 12));
	check("truncated log warns", !cut.finished && cut.warnings.length > 0, cut.warnings.join("; "));

	let old_version = log_bytes.slice();
	old_version[8] = 0;
	assert.throws(() => WinBoloLog.parse_log(old_version), /version 0/);
	check("version 0 is refused", true);
}

function test_viewer_build() {
	let committed = fs.readFileSync(path.join(root, "viewer", "logparse.js"), "utf8").replace(/\r\n/g, "\n");
	check("viewer/logparse.js is up to date (node tools/build-viewer-parser.js)", committed === build());
}

async function test_sample() {
	let dir = path.join(root, "samples");
	if (!fs.existsSync(dir)) {
		console.log("skip samples/ (none present)");
		return;
	}
	for (let f of fs.readdirSync(dir).filter(f => f.endsWith(".wbv"))) {
		let bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
		let { log } = await WinBoloLog.open_archive(bytes, zip, inflate);
		check(`${f}: parses to the quit record`, log.finished && log.warnings.length === 0, log.warnings.join("; "));
		let game = WinBoloGame.build(log);
		let end = WinBoloGame.state_at(game, game.t1).state;
		check(`${f}: final state matches the build pass`, JSON.stringify(end.pills) === JSON.stringify(game.final.pills) &&
			JSON.stringify(end.bases) === JSON.stringify(game.final.bases));
	}
}

(async () => {
	await test_synthetic();
	test_viewer_build();
	await test_sample();
	console.log(failures ? `${failures} FAILED` : "all passed");
	process.exit(failures ? 1 : 0);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
