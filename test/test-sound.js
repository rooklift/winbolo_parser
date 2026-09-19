/* Tests: the sound rules (viewer/sound.js) on their own, inside the replay
 * engine on the synthetic log test.js builds and on hand-made events, the
 * audio pool against a fake Audio, and the sound list of every real replay
 * in samples/. */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const zip = require(path.join(root, "src", "zip.js"));
const inflate = require(path.join(root, "src", "inflate.js"));
const WinBoloLog = require(path.join(root, "src", "parse.js"));
const WinBoloGame = require(path.join(root, "viewer", "game.js"));
const WinBoloSound = require(path.join(root, "viewer", "sound.js"));
const { synthetic_log } = require("./test.js");

const EV = WinBoloLog.EVENT;
const { variant, between, burst_sound, terrain_sound, wreckage_sounds, push_sound } = WinBoloSound;

let failures = 0;
function check(what, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

const KINDS = ["shooting", "hit_tank", "shot_tree", "shot_building", "mine_explosion", "big_explosion",
	"tank_sinking", "farming_tree", "man_building", "man_dying", "man_lay_mine"];

/* ---------- variants: near, far, self ---------- */
function test_variants() {
	/* the listener is the visible area: a view w by h tiles centred on (x, y) */
	let view_at = (x, y, w = 24, h = 16) => ({ left: x - w / 2, top: y - h / 2, right: x + w / 2, bottom: y + h / 2 });
	let listener = view_at(50.5, 50.5);
	let shot = { tick: 10, kind: "shooting", player: 2, x: 50.5, y: 50.5 };
	check("a free camera hears its own tank's shot as near, never self", variant(shot, listener, -1) === "shooting_near");
	check("off screen is far", variant(shot, view_at(70.5, 50.5), -1) === "shooting_far");
	check("the far side of the map is still far, not silent", variant(shot, view_at(240.5, 240.5), 1) === "shooting_far");
	check("the locked player's shot is self", variant(shot, listener, 2) === "shooting_self");
	check("another player's shot is not", variant(shot, listener, 1) === "shooting_near");
	check("a pillbox's shot is never self", variant({ ...shot, player: null }, listener, 2) === "shooting_near");
	check("a hit on the locked player is self", variant({ ...shot, kind: "hit_tank" }, listener, 2) === "hit_tank_self");
	check("a hit on another player is not", variant({ ...shot, kind: "hit_tank" }, listener, 1) === "hit_tank_near");
	check("only gunfire and hits have a self variant", variant({ ...shot, kind: "man_dying" }, listener, 2) === "man_dying_near");
	check("on the left edge of the view is on screen", variant(shot, view_at(62.5, 50.5), 1) === "shooting_near");
	check("just beyond the left edge is far", variant(shot, view_at(62.6, 50.5), 1) === "shooting_far");
	check("just inside the right edge is near", variant(shot, view_at(38.6, 50.5), 1) === "shooting_near");
	check("on the right edge is off screen, so far", variant(shot, view_at(38.5, 50.5), 1) === "shooting_far");
	check("on the top edge is on screen", variant(shot, view_at(50.5, 58.5), 1) === "shooting_near");
	check("on the bottom edge is off screen", variant(shot, view_at(50.5, 42.5), 1) === "shooting_far");
	check("near depends on the view, not a fixed radius", variant(shot, view_at(95.5, 50.5, 100, 100), 1) === "shooting_near");
	check("no listener, no sound", variant(shot, null, 2) === null);
	check("mine laying has no far variant", variant({ ...shot, kind: "man_lay_mine" }, view_at(70.5, 50.5), 1) === null);
	check("mine laying near", variant({ ...shot, kind: "man_lay_mine" }, listener, 1) === "man_lay_mine_near");

	/* every variant of every kind has its sample, and every sample is some variant */
	let dir = path.join(root, "viewer", "sounds");
	let names = new Set();
	for (let kind of KINDS) for (let viewpoint of [1, 2]) for (let x of [50.5, 70.5]) {
		let name = variant({ ...shot, kind }, view_at(x, 50.5), viewpoint);
		if (name) names.add(name);
	}
	let missing = [...names].filter(name => !fs.existsSync(path.join(dir, name + ".wav")));
	check("every variant has its sample in viewer/sounds", missing.length === 0, missing.join(", "));
	let unused = fs.readdirSync(dir).filter(f => !names.has(f.replace(/\.wav$/, "")));
	check("every sample in viewer/sounds is played by some variant", unused.length === 0, unused.join(", "));
	check("the samples are 16-bit PCM WAVs", fs.readdirSync(dir).every(f => {
		let b = fs.readFileSync(path.join(dir, f));
		return b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE" && b.readUInt16LE(34) === 16;
	}));

	let events = [{ tick: 5 }, { tick: 10 }, { tick: 10 }, { tick: 12 }, { tick: 20 }];
	check("between takes the sounds after from up to and including to", between(events, 5, 12).length === 3 && between(events, 12, 20).length === 1 && between(events, 20, 30).length === 0);
}

/* ---------- the rules ---------- */
function test_rules() {
	check("a burst on a tank is a hit", burst_sound("tank", 7) === "hit_tank");
	check("a burst on a pillbox is a building shot", burst_sound("pill", 7) === "shot_building");
	check("a burst on forest is a tree shot", burst_sound("terrain", 5) === "shot_tree" && burst_sound("terrain", 13) === "shot_tree");
	check("a burst on anything else is a building shot", burst_sound("terrain", 0) === "shot_building" && burst_sound("terrain", 7) === "shot_building" && burst_sound("terrain", 9) === "shot_building");
	check("a fall is silent", burst_sound("fall", 7) === null);

	check("a mine going off", terrain_sound(12, 3, true) === "mine_explosion" && terrain_sound(15, 3, false) === "mine_explosion");
	check("a crater from anything else is wreckage landing", terrain_sound(4, 3, true) === "crater" && terrain_sound(7, 3, false) === "crater");
	check("a crater staying a crater is nothing", terrain_sound(3, 3, true) === null);
	check("a mine laid", terrain_sound(4, 12, false) === "man_lay_mine" && terrain_sound(7, 15, false) === "man_lay_mine");
	check("a building shot to a half building is not a mine laid", terrain_sound(0, 8, false) === "shot_building");
	check("a building hit but standing, and a half building to rubble", terrain_sound(8, 8, false) === "shot_building" && terrain_sound(8, 6, false) === "shot_building");
	check("forest to grass is farming", terrain_sound(5, 7, false) === "farming_tree" && terrain_sound(13, 15, false) === "farming_tree");
	check("unless something blasted the square", terrain_sound(5, 7, true) === "shot_tree");
	check("a boat picked up is silent, a boat run over is a building shot", terrain_sound(9, 1, false) === null && terrain_sound(9, 1, true) === "shot_building");
	check("a road or a building built", terrain_sound(3, 4, false) === "man_building" && terrain_sound(7, 0, false) === "man_building" && terrain_sound(8, 0, false) === "man_building" && terrain_sound(15, 12, false) === "man_building");
	check("a boat built is silent", terrain_sound(1, 9, false) === null);
	check("growth and flooding are silent", terrain_sound(7, 5, false) === null && terrain_sound(3, 1, false) === null && terrain_sound(2, 1, false) === null);

	let block = [{ x: 101, y: 101 }, { x: 101, y: 100 }, { x: 100, y: 101 }, { x: 100, y: 100 }];
	let big = wreckage_sounds(7, block);
	check("a block of craters is one big explosion, at the last", big.length === 1 && big[0].kind === "big_explosion" && big[0].tick === 7 && big[0].x === 100.5 && big[0].y === 100.5, JSON.stringify(big));
	check("three craters are still a block", wreckage_sounds(7, block.slice(0, 3)).map(s => s.kind).join() === "big_explosion");
	let small = wreckage_sounds(7, [{ x: 100, y: 100 }, { x: 120, y: 120 }]);
	check("lone craters are small explosions each", small.map(s => s.kind).join() === "mine_explosion,mine_explosion" && small[1].x === 120.5);
	check("no craters, no sound", wreckage_sounds(7, []).length === 0);

	let sounds = [];
	push_sound(sounds, { tick: 1, kind: "man_building", player: null, x: 1.5, y: 1.5 });
	push_sound(sounds, { tick: 1, kind: "man_building", player: null, x: 1.5, y: 1.5 });
	push_sound(sounds, { tick: 1, kind: "man_building", player: null, x: 2.5, y: 1.5 });
	push_sound(sounds, { tick: 2, kind: "man_building", player: null, x: 1.5, y: 1.5 });
	check("the same sound at the same spot in one tick is one sound", sounds.length === 3);
}

/* ---------- the audio pool ---------- */
function test_player() {
	let played = [], audios = [];
	let fake_audio = url => {
		let audio = { url, paused: true, currentTime: 0,
			play() { this.paused = false; played.push(url); return Promise.resolve(); },
			pause() { this.paused = true; },
		};
		audios.push(audio);
		return audio;
	};
	let pitches = [0, 1, 0.5];
	let player = WinBoloSound.create_player(fake_audio, () => pitches.length ? pitches.shift() : 0.5);
	let listener = { left: 38.5, top: 42.5, right: 62.5, bottom: 58.5 };
	let shot = { tick: 10, kind: "shooting", player: 2, x: 50.5, y: 50.5 };
	let events = [shot, { ...shot, tick: 20 }];
	let advance = (from, to, speed = 1, viewpoint = 2) => player.advance(events, from, to, speed, viewpoint, () => listener);
	advance(0, 10);
	advance(10, 11);
	check("a sound on a frame boundary plays once", played.length === 1 && played[0] === "sounds/shooting_self.wav", played.join());
	check("half volume, pitch varied within 3% and not corrected", audios[0].volume === 0.5 && audios[0].playbackRate === 0.97 && audios[0].preservesPitch === false);
	advance(11, 20, 2);
	check("fast playback is silent and stops what is playing", played.length === 1 && audios.every(a => a.paused));
	advance(20, 21);
	check("returning to normal speed does not replay skipped sounds", played.length === 1);
	advance(20, 0);
	check("backward movement is silent", played.length === 1);
	advance(0, 10, 0.5, 1);
	check("slow playback plays, for the viewpoint of the moment, each trigger with its own pitch", played.at(-1) === "sounds/shooting_near.wav" && audios[1].playbackRate === 1.03);
	player.set_enabled(false);
	advance(10, 20);
	check("disabled is silent", played.length === 2 && audios.every(a => a.paused));
	player.set_enabled(true);
	let before = played.length;
	player.advance(Array.from({ length: 50 }, () => shot), 0, 10, 1, 2, () => listener);
	check("simultaneous copies of each sound are bounded", audios.length <= 5, String(audios.length));
	check("a full pool restarts a voice rather than dropping the trigger", played.length - before === 50);
	player.stop();
	check("stop pauses everything", audios.every(a => a.paused && a.currentTime === 0));
}

/* ---------- inside the engine: the synthetic log ---------- */
function test_synthetic() {
	let log = WinBoloLog.parse_log(synthetic_log());
	let game = WinBoloGame.build(log);
	let at = tick => game.sounds.filter(s => s.tick === tick);
	let kinds_at = tick => at(tick).map(s => s.kind).join(",");
	check("the game has sounds, in tick order, within the replay", game.sounds.length > 0 && game.sounds.every((s, i) => s.tick >= game.t0 && s.tick <= game.t1 && (i === 0 || game.sounds[i - 1].tick <= s.tick)));
	check("every sound has a known kind", game.sounds.every(s => KINDS.includes(s.kind)), game.sounds.map(s => s.kind).join());
	let shot = at(268).find(s => s.kind === "shooting");
	check("a shell traced to Alice's tank is her shot, at her muzzle", shot && shot.player === 0 && shot.x === 100.5 && shot.y === 100.5, JSON.stringify(at(268)));
	check("a crater from no mine is small wreckage landing", kinds_at(268) === "shooting,mine_explosion" && at(268)[1].x === 103.5, kinds_at(268));
	check("a pill's armour going down is silent here (its burst is the sound)", !at(268).some(s => s.kind === "man_building"));
	let man = at(269);
	check("the lost builder dies where he stood", man.length === 1 && man[0].kind === "man_dying" && man[0].player === null && Math.abs(man[0].x - 101.5) < 0.01 && Math.abs(man[0].y - 100.25) < 0.01, JSON.stringify(man));
	check("a shell fired is a shot, its fall is silent", kinds_at(525) === "shooting" && at(529).length === 0 && at(530).length === 0);
	check("a terrain hit on a road is a building shot, at the square's centre", kinds_at(539) === "shot_building" && at(539)[0].x === 102.5 && at(539)[0].y === 100.5, kinds_at(539));
	check("a pillbox kill is silent", at(540).length === 0);
	check("a mine laid", kinds_at(542) === "man_lay_mine" && at(542)[0].x === 100.5);
	check("a mine going off", kinds_at(543) === "mine_explosion");
	check("a death under a mine adds nothing to the mine's blast", at(544).length === 0);
	check("a drowning sinks, and the parting shot is a shot", kinds_at(546) === "tank_sinking,shooting" && at(546)[1].player === 0, kinds_at(546));
	let pill_shot = at(548);
	check("the pillbox's shell is nobody's shot, from the pillbox", pill_shot.length === 1 && pill_shot[0].kind === "shooting" && pill_shot[0].player === null && pill_shot[0].x === 101.5 && pill_shot[0].y === 102.5, JSON.stringify(pill_shot));
	let hit = at(565);
	check("the hit on Alice names her, for the self variant", hit.length === 1 && hit[0].kind === "hit_tank" && hit[0].player === 0, JSON.stringify(hit));
	check("the sunk boat sinks", kinds_at(566) === "tank_sinking");
	check("a shell from nowhere makes no shot", at(570).length === 0);
	check("but its hit is heard, and the sinking after it", kinds_at(593) === "hit_tank" && kinds_at(594) === "tank_sinking");
	check("nothing else sounds", game.sounds.length === 15, String(game.sounds.length));
	check("seeking does not annotate: only the build pass notes a change's old terrain",
		WinBoloGame.state_at(game, 543).state.grid[100 * 256 + 100] === 3);
}

/* ---------- inside the engine: hand-made events on the synthetic snapshot ---------- */
function test_events() {
	let snap = structuredClone(WinBoloLog.parse_log(synthetic_log()).snapshots[0]);
	let run = events => WinBoloGame.build({ header: {}, snapshots: [snap], events, ticks: 20 }).sounds;
	let pill = (tick, type, extra) => ({ tick, type, pill: 0, ...extra });
	let sounds = run([
		pill(1, EV.PillSetHealth, { armour: 12 }),
		pill(2, EV.PillSetHealth, { armour: 15 }),
		pill(3, EV.PillSetInTank, { in_tank: true }),
		pill(4, EV.PillSetOwner, { owner: 0, migrate: true }), pill(4, EV.PillSetHealth, { armour: 15 }),
		pill(4, EV.PillSetInTank, { in_tank: false }), pill(4, EV.PillSetPlace, { x: 110, y: 110 }),
		pill(5, EV.PillSetInTank, { in_tank: true }),
		pill(6, EV.PillSetOwner, { owner: 0, migrate: true }), pill(6, EV.PillSetHealth, { armour: 0 }),
		pill(6, EV.PillSetInTank, { in_tank: false }), pill(6, EV.PillSetPlace, { x: 111, y: 111 }),
		pill(7, EV.PillSetHealth, { armour: 15 }),
	]);
	let by_tick = {};
	for (let s of sounds) (by_tick[s.tick] = by_tick[s.tick] || []).push(s);
	check("a pill's armour going down is silent", !by_tick[1]);
	check("a pill repaired is the builder building, at the pill", by_tick[2] && by_tick[2].length === 1 && by_tick[2][0].kind === "man_building" && by_tick[2][0].x === 101.5 && by_tick[2][0].y === 102.5, JSON.stringify(by_tick[2]));
	check("a pill picked up is silent", !by_tick[3] && !by_tick[5]);
	check("a pill put down is one building sound, where it lands", by_tick[4] && by_tick[4].length === 1 && by_tick[4][0].kind === "man_building" && by_tick[4][0].x === 110.5 && by_tick[4][0].y === 110.5, JSON.stringify(by_tick[4]));
	check("a dying tank's pill lands dead and silently", !by_tick[6]);
	check("a dead pill repaired is building", by_tick[7] && by_tick[7].length === 1 && by_tick[7][0].x === 111.5);

	/* terrain: the map's land is grass, road, road, forest along row 100
	 * from x 100 and building, building, building, river along row 101 */
	let change = (tick, x, y, terrain) => ({ tick, type: EV.MapChange, x, y, terrain });
	let burst = (tick, mx, my) => ({ tick, type: EV.Shell, mx, my, px: 0, py: 0, explosion: 8 });
	sounds = run([
		change(1, 101, 100, 3), change(1, 100, 100, 3), change(1, 101, 101, 3), change(1, 100, 101, 3),
		burst(2, 103, 100), change(2, 103, 100, 7),
		change(3, 102, 101, 8),
		change(4, 100, 100, 4),
		change(5, 101, 100, 1),
		change(6, 102, 100, 3),
		change(7, 103, 100, 5),
		change(8, 103, 100, 7),
		change(9, 103, 101, 9),
	]);
	by_tick = {};
	for (let s of sounds) (by_tick[s.tick] = by_tick[s.tick] || []).push(s);
	check("a block of craters is one big explosion, at the last crater", by_tick[1] && by_tick[1].length === 1 && by_tick[1][0].kind === "big_explosion" && by_tick[1][0].x === 100.5 && by_tick[1][0].y === 101.5, JSON.stringify(by_tick[1]));
	check("a tree under an untraced burst is shot, not farmed", by_tick[2] && by_tick[2].map(s => s.kind).join() === "shot_tree");
	check("a building shot with no burst traced is still a building shot", by_tick[3] && by_tick[3].map(s => s.kind).join() === "shot_building");
	check("a road built on a crater", by_tick[4] && by_tick[4].map(s => s.kind).join() === "man_building");
	check("a crater flooding is silent", !by_tick[5]);
	check("a lone crater is small wreckage", by_tick[6] && by_tick[6].map(s => s.kind).join() === "mine_explosion");
	check("growth is silent", !by_tick[7]);
	check("a tree farmed", by_tick[8] && by_tick[8].map(s => s.kind).join() === "farming_tree");
	check("a boat built is silent", !by_tick[9]);
}

/* ---------- the real replays ---------- */
async function test_samples() {
	let dir = path.join(root, "samples");
	for (let f of fs.readdirSync(dir).filter(f => f.endsWith(".wbv"))) {
		let { log } = await WinBoloLog.open_archive(new Uint8Array(fs.readFileSync(path.join(dir, f))), zip, inflate);
		let game = WinBoloGame.build(log);
		let sounds = game.sounds;
		check(`${f}: sounds in tick order, within the replay, of known kinds`, sounds.length > 0
			&& sounds.every((s, i) => s.tick >= game.t0 && s.tick <= game.t1 && KINDS.includes(s.kind) && (i === 0 || sounds[i - 1].tick <= s.tick)));
		/* every shell traced to a muzzle is a shot from that gun in that tick, and
		 * vice versa; two shells credited to one gun in one tick are one shot */
		let shots = sounds.filter(s => s.kind === "shooting");
		let births = log.events.filter(e => e.type === EV.Shell && e.dir !== undefined && e.age === 0 && e.owner !== null && e.tick >= game.t0);
		let key = (tick, player) => `${tick}:${player}`;
		let shot_keys = new Set(shots.map(s => key(s.tick, s.player)));
		let birth_keys = new Set(births.map(b => key(b.tick, b.owner === WinBoloGame.PILL_OWNER ? null : b.owner)));
		check(`${f}: a shot per gun per tick a shell was traced to it`, shots.length > 0 && shots.length <= births.length
			&& shot_keys.size === birth_keys.size && [...shot_keys].every(k => birth_keys.has(k)), `${shots.length} shots, ${births.length} births`);
		let hits = sounds.filter(s => s.kind === "hit_tank").length;
		let tank_bursts = log.events.filter(e => e.type === EV.Shell && e.cause === "tank" && e.age !== undefined && e.tick >= game.t0).length;
		check(`${f}: one hit per burst on a tank`, hits === tank_bursts && hits > 0, `${hits} hits, ${tank_bursts} bursts`);
		let deaths = log.events.filter(e => e.type === EV.KillPlayer && e.tick >= game.t0).length;
		let landings = sounds.filter(s => s.kind === "big_explosion" || s.kind === "mine_explosion").length;
		check(`${f}: wreckage lands after deaths`, landings > 0 && landings <= deaths + 1, `${landings} landings, ${deaths} deaths`);
		check(`${f}: the builders build and farm`, sounds.some(s => s.kind === "man_building") && sounds.some(s => s.kind === "farming_tree"));
		check(`${f}: the events annotated for the sounds are the log's own`, log.events.filter(e => e.type === EV.MapChange).every(e => e.from !== undefined));
	}
}

(async () => {
	test_variants();
	test_rules();
	test_player();
	test_synthetic();
	test_events();
	await test_samples();
	console.log(failures ? `${failures} FAILED` : "all sound checks passed");
	process.exit(failures ? 1 : 0);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
