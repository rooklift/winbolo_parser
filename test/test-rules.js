/* Tests: the shell tracker under WinBolo 2.1's shell rules, the speed a
 * shell flies at and how far ahead of its muzzle it starts, as scripts.json
 * opens a round with them and RuleSet events change them; and a lag
 * compensated hit found by the armour it took. Hand-made events
 * on the synthetic log's opening snapshot, where Alice's tank sits at
 * (100.5, 100.5). */
"use strict";
const path = require("path");

const root = path.join(__dirname, "..");
const zip = require(path.join(root, "src", "zip.js"));
const inflate = require(path.join(root, "src", "inflate.js"));
const WinBoloLog = require(path.join(root, "src", "parse.js"));
const WinBoloGame = require(path.join(root, "viewer", "game.js"));
const { synthetic_log, make_zip } = require("./test.js");

const EV = WinBoloLog.EVENT;

let failures = 0;
function check(what, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

let snap = WinBoloLog.parse_log(synthetic_log()).snapshots[0];
let point = (x, y) => ({ mx: Math.floor(x), my: Math.floor(y), px: Math.round((x % 1) * 16), py: Math.round((y % 1) * 16) });
/* a shell in flight at (x, y), heading east unless told otherwise */
let shell = (tick, x, y = 100.5, dir = 4) => ({ tick, type: EV.Shell, ...point(x, y), dir });
let burst = (tick, x, y = 100.5) => ({ tick, type: EV.Shell, ...point(x - 0.5, y - 0.5), explosion: 8 });
let rule = (tick, value, index = 63) => ({ tick, type: EV.RuleSet, rule: index, rule_name: WinBoloLog.RULE_NAMES[index], value });
let run = (events, scripts = null, snapshots = [structuredClone(snap)]) =>
	WinBoloGame.build({ header: {}, snapshots, events, ticks: 20 }, scripts);
let shots = game => game.sounds.filter(s => s.kind === "shooting");
let flights = events => events.filter(e => e.dir !== undefined).map(e => [e.owner, e.age]);

function test_speeds() {
	/* a shell fired at 192 keeps that speed after the rule goes back to
	 * 32, while one fired after the change flies at 32 beside it */
	let events = [shell(1, 104.25), rule(2, 32), shell(2, 105), shell(2, 101.125),
		shell(3, 105.75), shell(3, 101.25), burst(4, 107), shell(4, 101.375)];
	let scripts = { version: 1, rules: { shell_speed: 192 } };
	let game = run(events, scripts);
	check("the game keeps its scripts.json", game.scripts === scripts);
	check("old and new speeds side by side", JSON.stringify(flights(events)) === JSON.stringify([[0, 0], [0, 1], [0, 0], [0, 2], [0, 1], [0, 2]]), JSON.stringify(flights(events)));
	check("a fast shell's burst is found further on", events[6].owner === 0 && events[6].cause === "fall", JSON.stringify(events[6]));
	check("a shot for each shell", JSON.stringify(shots(game).map(s => s.tick)) === "[1,2]");
	let annotations = JSON.stringify(events);
	WinBoloGame.state_at(game, 4); WinBoloGame.state_at(game, 1); WinBoloGame.state_at(game, 4);
	check("seeking leaves the annotations alone", JSON.stringify(events) === annotations);

	/* rules in quiet ticks, and several in one tick, apply in order; a
	 * later snapshot does not put the classic rules back */
	events = [rule(0, 192), rule(1, 128), rule(1, 64), shell(2, 101.75), shell(3, 102), shell(4, 102.25)];
	let later = { ...structuredClone(snap), tick: 3, event_index: 4 };
	game = run(events, null, [structuredClone(snap), later]);
	check("the last of several rules wins, across a snapshot", JSON.stringify(flights(events)) === "[[0,0],[0,1],[0,2]]" && shots(game).length === 1, JSON.stringify(flights(events)));

	/* a rule changed partway through a tick: the shell logged before it
	 * keeps the old speed, the one after takes the new */
	events = [shell(1, 101.125), rule(1, 192), shell(1, 100.5, 96.75, 0), shell(2, 101.25), shell(2, 100.5, 96, 0)];
	game = run(events);
	check("a change partway through a tick", JSON.stringify(flights(events)) === "[[0,0],[0,0],[0,1],[0,1]]" && shots(game).length === 1, JSON.stringify(flights(events)));
}

function test_muzzles() {
	/* a fast shell starts well out; the tank it passes is not its gun */
	let crowded = structuredClone(snap);
	crowded.players[1] = { ...structuredClone(snap.players[0]), slot: 1, tank: { ...snap.players[0].tank, ...point(103.5, 100.5) } };
	let game = run([shell(1, 104.25), shell(2, 105)], { version: 1, rules: { shell_speed: 192 } }, [crowded]);
	check("a fast shell is traced past a nearer tank to its own", shots(game)[0] && shots(game)[0].player === 0, JSON.stringify(shots(game)));

	let events = [rule(0, 8, 64), shell(1, 102.5), shell(2, 102.75)];
	run(events, { version: 1, rules: { shell_speed: 64, shell_start_add: 0 } });
	check("a changed start offset", JSON.stringify(flights(events)) === "[[0,0],[0,1]]", JSON.stringify(flights(events)));

	/* a shell at full speed near the edge of one of the log's 16 headings */
	events = [shell(1, 101.4375, 95.625, 0), shell(2, 101.625, 94.625, 0), shell(3, 101.8125, 93.6875, 0)];
	run(events, { version: 1, rules: { shell_speed: 255 } });
	check("a fast shell off its rounded heading", JSON.stringify(flights(events)) === "[[0,0],[0,1],[0,2]]", JSON.stringify(flights(events)));
}

function test_bad_rules() {
	for (let value of [null, "192", -1, 0, 256, 3.5, NaN, Infinity]) {
		let events = [rule(0, value), shell(1, 101.125), shell(2, 101.25)];
		let game = run(events, { version: 1, rules: { shell_speed: value, shell_start_add: -1 } });
		check(`a shell speed of ${JSON.stringify(value)} is ignored`, JSON.stringify(flights(events)) === "[[0,0],[0,1]]" && shots(game).length === 1, JSON.stringify(flights(events)));
	}
	let events = [rule(0, 192, 999), rule(0, 192, 17), shell(1, 101.125), shell(2, 101.25)];
	run(events);
	check("other rules leave the shells alone", events.at(-1).age === 1);
}

/* A hit judged on the shooter's screen bursts where the tank was, up to
 * 14 ticks ago: away from Alice, a burst is hers when 2.1's stocks say
 * she lost armour in its tick, and a fall when they do not. */
function test_lag_hits() {
	let stock = (tick, armour) => ({ tick, type: EV.TankSetStock, player: 0, shells: 40, mines: 40, armour, trees: 0 });
	/* a shell heading west, too far from Alice to be hers, bursting 1.8 tiles from her */
	let hit = (...extra) => [stock(0, 40), shell(1, 102.25, 101.5, 12), shell(2, 102.125, 101.5, 12), ...extra, burst(3, 102, 101.5)];
	let events = hit(stock(3, 35));
	run(events);
	let b = events.find(e => e.explosion !== undefined);
	check("a burst away from a tank that lost armour is its hit", b.cause === "tank", JSON.stringify(b));
	events = hit();
	run(events);
	check("with no armour lost it is a fall", events.find(e => e.explosion !== undefined).cause === "fall");
	events = hit(stock(3, 40));
	run(events);
	check("stocks that keep the armour are no hit", events.find(e => e.explosion !== undefined).cause === "fall");
	events = [stock(0, 40), shell(1, 103.25, 101.5, 12), shell(2, 103.125, 101.5, 12), stock(3, 35), burst(3, 103, 101.5)];
	run(events);
	check("a tank hurt more than 2 tiles away is not the one hit", events.find(e => e.explosion !== undefined).cause === "fall");
}

/* A pillbox's shell carries whose the pillbox was when it fired, for its
 * colour: the opening snapshot's pillbox at (101, 102) is nobody's. */
function test_pill_shells() {
	let events = [shell(1, 102.125, 102.5), shell(2, 102.25, 102.5)];
	run(events);
	check("a neutral pillbox's shell", events.every(e => e.owner === WinBoloGame.PILL_OWNER && e.pill_owner === WinBoloLog.NEUTRAL), JSON.stringify(events));
	let owned = structuredClone(snap);
	owned.pills[0].owner = 0;
	events = [shell(1, 102.125, 102.5), shell(2, 102.25, 102.5)];
	run(events, null, [owned]);
	check("an owned pillbox's shell", events.every(e => e.owner === WinBoloGame.PILL_OWNER && e.pill_owner === 0), JSON.stringify(events));
	events = [shell(1, 101.125)];
	run(events);
	check("a tank's shell has no pillbox owner", events[0].owner === 0 && events[0].pill_owner === undefined, JSON.stringify(events));
}

/* The rules table the viewer shows: scripts.json's, then what the round
 * start wrote over it, then the changes during the game. */
function test_rule_table() {
	let events = [rule(0, 64), rule(0, 0.25, 108), shell(1, 101.125), rule(5, 128), rule(6, 4, 999), rule(6, 2, 300)];
	let game = run(events, { version: 1, rules: { tank_reload_ticks: 8, shell_speed: 192 } });
	let table = WinBoloGame.rule_table(game);
	check("the rule table, by name", JSON.stringify(table) === JSON.stringify([
		{ name: WinBoloLog.RULE_NAMES[108], value: 0.25, changes: [] },
		{ name: "shell_speed", value: 64, changes: [{ tick: 5, value: 128 }] },
		{ name: "tank_reload_ticks", value: 8, changes: [] },
		{ name: "rule 300", value: undefined, changes: [{ tick: 6, value: 2 }] },
		{ name: "rule 999", value: undefined, changes: [{ tick: 6, value: 4 }] },
	]), JSON.stringify(table));
	check("no rules, no table", WinBoloGame.rule_table(run([shell(1, 101.125)])).length === 0);
}

/* The game type: the header's, unless the lobby changed it before the
 * round started; a change after the start is not the round's. */
function test_game_type() {
	let settings = (tick, game_type) => ({ tick, type: EV.GameSettings, game_type });
	let typed = (events, t0) => {
		let game = WinBoloGame.build({ header: { game_type: 3 }, snapshots: [structuredClone(snap)], events, ticks: 20 });
		game.t0 = t0;
		return WinBoloGame.game_type(game);
	};
	check("the header's type without settings", typed([], 0) === 3);
	check("the lobby's change before the start", typed([settings(0, 3), settings(2, 1), settings(4, 1)], 4) === 1);
	check("not a change after the start", typed([settings(0, 2), settings(5, 1)], 4) === 2);
	check("a blob without the type", typed([settings(0, 0)], 4) === 3);
}

/* The lag summary the viewer shows: the server's timing from its last
 * OverrunStats, each player's round trip, and the spikes, with the
 * round's first two seconds left out. */
function test_lag_summary() {
	let lag = (tick, player, rtt_ms) => ({ tick, type: EV.PlayerLag, player, rtt_ms, rewind_ticks: 5 });
	let stats = (tick, round_frames, tick_peak_ms, over_budget, extra = {}) => ({
		tick, type: EV.OverrunStats, round_frames, tick_peak_ms, over_budget, budget_ms: 20, has_bots: false, ...extra,
	});
	let summed = events => {
		let game = WinBoloGame.build({ header: {}, snapshots: [structuredClone(snap)], events, ticks: 4000 });
		game.t0 = 10;
		return WinBoloGame.lag_summary(game);
	};
	check("no lag records, no summary", summed([shell(11, 101.125)]) === null);

	let events = [
		lag(5, 0, 999),                                     /* before the game: not its lag */
		lag(10, 0, 600), lag(10, 1, 650), lag(10, 2, 0),    /* the round start's long readings */
		lag(60, 0, 60), lag(60, 1, 150), lag(60, 2, 0),
		lag(110, 0, 60), lag(110, 1, 150), lag(110, 2, 0),
		lag(160, 0, 62), lag(160, 1, 150),
		lag(200, 0, 900), lag(205, 1, 950),                 /* both at once */
		lag(210, 0, 60), lag(210, 1, 150),
		lag(260, 0, 58), lag(260, 1, 150),
		lag(400, 1, 420),                                   /* one alone */
		lag(450, 1, 150),
		stats(1510, 1500, 30.5, 4),
		stats(3010, 3000, 950.2, 9),
		stats(3500, 3490, 950.2, 11, { round_end: true }),
		stats(3600, 1500, 5000, 99),                        /* another round's */
	];
	let s = summed(events);
	check("lag: the server's last record, and when its worst frame came", JSON.stringify(s.server) === JSON.stringify({
		frames: 3490, over_budget: 11, budget_ms: 20, peak_ms: 950.2, peak_from: 1510, peak_to: 3010, bots: null,
	}), JSON.stringify(s.server));
	check("lag: the players, without the bot or the round start", JSON.stringify(s.players) === JSON.stringify([
		{ player: 0, typical_ms: 60, worst_ms: 900 },
		{ player: 1, typical_ms: 150, worst_ms: 950 },
	]), JSON.stringify(s.players));
	check("lag: spikes, shared and alone", JSON.stringify(s.spikes) === JSON.stringify([
		{ tick: 200, players: [0, 1], peak_ms: 950 },
		{ tick: 400, players: [1], peak_ms: 420 },
	]), JSON.stringify(s.spikes));

	let bots = summed([stats(1510, 1500, 12, 0, { has_bots: true, target_ms: 12, total_overruns: 30, total_thinks: 1500, brain_peak_ms: 44.5 })]);
	check("lag: a server record alone, with its bots", bots.players.length === 0 && bots.spikes.length === 0 &&
		JSON.stringify(bots.server.bots) === JSON.stringify({ target_ms: 12, overruns: 30, thinks: 1500, peak_ms: 44.5 }), JSON.stringify(bots));
	let alone = summed([lag(10, 3, 80)]);
	check("lag: a player with no record after the start", alone.server === null &&
		JSON.stringify(alone.players) === JSON.stringify([{ player: 3, typical_ms: 80, worst_ms: null }]), JSON.stringify(alone));
}

async function test_archive() {
	let scripts = { version: 1, rules: { shell_speed: 192 } };
	let bytes = make_zip([["log.dat", synthetic_log()], ["scripts.json", Buffer.from(JSON.stringify(scripts))]]);
	let archive = await WinBoloLog.open_archive(bytes, zip, inflate);
	check("scripts.json read from the archive", JSON.stringify(archive.scripts) === JSON.stringify(scripts));
	archive.log.events = [shell(1, 104.25), shell(2, 105)];
	archive.log.snapshots = [structuredClone(snap)];
	let steps = WinBoloGame.build_steps(archive.log, archive.scripts), step;
	do { step = steps.next(); } while (!step.done);
	check("its rules reach the build", step.value.events[1].age === 1 && step.value.events[1].owner === 0);
	let broken = await WinBoloLog.open_archive(make_zip([["log.dat", synthetic_log()], ["scripts.json", Buffer.from("[1, 2")]]), zip, inflate);
	check("a broken scripts.json is a warning", broken.scripts === null && broken.log.warnings.some(w => w.startsWith("scripts.json:")));
}

(async () => {
	test_speeds();
	test_muzzles();
	test_bad_rules();
	test_lag_hits();
	test_pill_shells();
	test_rule_table();
	test_game_type();
	test_lag_summary();
	await test_archive();
	console.log(failures ? `${failures} FAILED` : "all rule checks passed");
	process.exit(failures ? 1 : 0);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
