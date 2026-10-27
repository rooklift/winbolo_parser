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
	await test_archive();
	console.log(failures ? `${failures} FAILED` : "all rule checks passed");
	process.exit(failures ? 1 : 0);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
