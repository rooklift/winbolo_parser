/* Replay sounds: what the log implies made a noise, and a bounded HTML
 * audio pool to play it. The format has Sound events (types 7 to 17) but
 * no server writes them, so every sound here is inferred from what the
 * log does state, on the rules of WinBolo's own source (shells.c,
 * tankexp.c, lgm.c, tank.c): gunfire from each shell the tracker traces
 * to a muzzle, hits from the bursts it explains, the rest from what
 * happens to the terrain and the pillboxes. game.js collects them during
 * the build pass; renderer.js plays them. HTML audio also works when the
 * viewer is opened directly from disk. No network dependencies. */
"use strict";
(function () {

/* file terrain codes; a mine adds MINE_OFFSET to the terrain it lies in */
const BUILDING = 0, RIVER = 1, CRATER = 3, ROAD = 4, FOREST = 5, RUBBLE = 6, GRASS = 7, HALFBUILDING = 8, BOAT = 9;
const MINE_START = 10, MINE_END = 15, MINE_OFFSET = 8;

function bare(terrain) {
	return terrain >= MINE_START && terrain <= MINE_END ? terrain - MINE_OFFSET : terrain;
}

/* The sound of a traced shell's burst, by what the tracker says it hit;
 * hit_terrain is the terrain of the square hit, for a terrain hit. A
 * shell falling at the end of its range is silent. */
function burst_sound(cause, hit_terrain) {
	switch (cause) {
		case "tank": return "hit_tank";
		case "pill": return "shot_building";
		case "terrain": return bare(hit_terrain) === FOREST ? "shot_tree" : "shot_building";
		default: return null;
	}
}

/* The sound of a square changing from one terrain to another, when no
 * traced shell burst on it (a shell's hit is sounded from its burst).
 * blasted: something the tracker could not trace burst on the square this
 * tick, which is tank wreckage flying over it or landing on it, a mine
 * going off, or a boat run over. Returns a sound kind, "crater" for
 * wreckage landing (the caller sizes the explosion by the craters it
 * makes), or null for the silent changes: growth, flooding, a boat built
 * (lgm.c plays nothing for one), a boat picked up. */
function terrain_sound(from, to, blasted) {
	if (to === CRATER) return from >= MINE_START ? "mine_explosion" : from === CRATER ? null : "crater";
	if (from < MINE_START && to >= MINE_START && to === from + MINE_OFFSET) return "man_lay_mine";
	let f = bare(from), t = bare(to);
	/* only a shell wears a building down, and a hit that leaves it standing
	 * is logged too, as a change to what it already was */
	if ((f === BUILDING || f === HALFBUILDING) && (t === HALFBUILDING || t === RUBBLE)) return "shot_building";
	if (f === t) return null;
	if (f === FOREST && t === GRASS) return blasted ? "shot_tree" : "farming_tree";
	if (f === BOAT && t === RIVER) return blasted ? "shot_building" : null;
	if (t === ROAD || t === BUILDING) return "man_building";
	return null;
}

/* Wreckage landing: a dying tank's ammunition flies off and lands as big
 * wreckage, which craters a block of up to four squares and goes off with
 * the big explosion, or as small wreckage, which craters one square with
 * the sound of a mine (tankexp.c). The craters made in one tick are
 * grouped by adjacency, and each group sounds once, at its last square,
 * where WinBolo plays it. */
function wreckage_sounds(tick, craters) {
	let groups = [];
	for (let c of craters) {
		let group = groups.find(g => g.some(o => Math.abs(o.x - c.x) <= 1 && Math.abs(o.y - c.y) <= 1));
		if (group) group.push(c);
		else groups.push([c]);
	}
	return groups.map(g => {
		let last = g[g.length - 1];
		return { tick, kind: g.length > 1 ? "big_explosion" : "mine_explosion", player: null, x: last.x + 0.5, y: last.y + 0.5 };
	});
}

/* Add a sound unless the same one is already down for the tick: a pill
 * dropped is logged as several events, and one building sound is enough. */
function push_sound(sounds, sound) {
	for (let i = sounds.length - 1; i >= 0 && sounds[i].tick === sound.tick; i--) {
		let s = sounds[i];
		if (s.kind === sound.kind && s.x === sound.x && s.y === sound.y) return;
	}
	sounds.push(sound);
}

/* player is the one the camera is locked to, or -1 with a free camera: only
 * a locked camera hears its player's own gunfire and hits as self sounds.
 * listener is the visible area in tiles (left, top, right, bottom). */
function variant(event, listener, player) {
	if (!listener) return null;
	if (player >= 0 && event.player === player && ["shooting", "hit_tank"].includes(event.kind)) return event.kind + "_self";
	/* An event on screen is near; one off screen is far, however distant. */
	let near = event.x >= listener.left && event.x < listener.right
		&& event.y >= listener.top && event.y < listener.bottom;
	if (event.kind === "man_lay_mine") return near ? "man_lay_mine_near" : null;
	return event.kind + (near ? "_near" : "_far");
}

/* The sounds after tick `from` up to and including tick `to`. */
function between(events, from, to) {
	let lo = 0, hi = events.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (events[mid].tick <= from) lo = mid + 1;
		else hi = mid;
	}
	let end = lo;
	while (end < events.length && events[end].tick <= to) end++;
	return events.slice(lo, end);
}

function create_player(make_audio = url => new Audio(url), random = Math.random) {
	let pools = new Map();
	let enabled = true;
	let triggers = 0;
	function stop() {
		for (let pool of pools.values()) for (let { audio } of pool) {
			audio.pause();
			audio.currentTime = 0;
		}
	}
	function play(name) {
		let pool = pools.get(name);
		if (!pool) { pool = []; pools.set(name, pool); }
		let voice = pool.find(v => v.audio.paused || v.audio.ended);
		if (!voice && pool.length < 4) {
			let audio = make_audio("sounds/" + name + ".wav");
			audio.volume = 0.5;
			voice = { audio, started: 0 };
			pool.push(voice);
		}
		/* Four copies of a sound at once is plenty: past that, the newest
		 * trigger restarts the copy that has played longest, so a burst of
		 * gunfire keeps its latest shots rather than losing them. */
		if (!voice) voice = pool.reduce((oldest, v) => v.started < oldest.started ? v : oldest);
		let { audio } = voice;
		voice.started = ++triggers;
		/* Vary each trigger, including pooled voices. Disable pitch correction
		 * so the small rate change changes pitch as well as duration. */
		audio.preservesPitch = false;
		audio.playbackRate = 0.97 + random() * 0.06;
		audio.currentTime = 0;
		/* Browsers may refuse autoplay until the first user interaction; a
		 * refused sound is simply dropped rather than queued. */
		let pending = audio.play();
		if (pending) pending.catch(() => {});
	}
	return {
		stop,
		set_enabled(value) { enabled = value; if (!value) stop(); },
		advance(events, from, to, speed, player, listener_at) {
			if (!enabled || speed > 1 || speed <= 0 || to <= from) { stop(); return; }
			for (let event of between(events, from, to)) {
				let name = variant(event, listener_at(event.tick), player);
				if (name) play(name);
			}
		},
	};
}

const WinBoloSound = { burst_sound, terrain_sound, wreckage_sounds, push_sound, variant, between, create_player };

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloSound;
} else {
	window.WinBoloSound = WinBoloSound;
}

})();
