/* Sprite terrain rendering: WinBolo's 16×16 tile art (sprites/*.png) plus
 * the neighbour rules that pick which variant each tile displays. The rules
 * are a direct port of screencalc.c from the WinBolo source, copyright
 * 1998-2008 John Morrison, GPL v2. Sprite names are the PNG filenames,
 * which themselves mirror WinBolo's tile enum names (BUILD_SIDECORN1 →
 * building_sidecorn1, ROAD_WATER5 → road_water5_corner, ...). */
"use strict";
(function () {

const MAP_SIZE = 256;

/* editor terrain codes (see format.js) */
const BUILDING = 0, RIVER = 1, ROAD = 4, FOREST = 5, HALFBUILDING = 8, BOAT = 9, DEEP_SEA = 255;

const TILE = 16;     /* native sprite size in pixels */
const MIN_ZOOM = 16; /* zoom at which sprites switch on (below this they'd downscale to mud) */

/* A neighbour for display purposes: mined terrain looks like its base
 * terrain (the mine is a separate overlay), and off-map is deep sea. */
function norm_at(grid, x, y) {
	if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return DEEP_SEA;
	let t = grid[y * MAP_SIZE + x];
	return (t >= 10 && t <= 15) ? t - 8 : t;
}

/* The calc functions below take the 8 surrounding squares in screencalc.c's
 * order — (aboveLeft, above, aboveRight, left, right, belowLeft, below,
 * belowRight) — and keep its exact chain of tests, including the quirks. */

let water_to_river = t => (t === DEEP_SEA || t === BOAT) ? RIVER : t;

function calc_road(al, a, ar, l, r, bl, b, br) {
	[al, a, ar, l, r, bl, b, br] = [al, a, ar, l, r, bl, b, br].map(water_to_river);
	if (al !== ROAD && a === ROAD && ar !== ROAD && l === ROAD && r === ROAD && bl !== ROAD && b === ROAD && br !== ROAD) return "road_crossroads";
	if (a === ROAD && l === ROAD && r === ROAD && b === ROAD) return "road_solid";
	if (l === RIVER && r === RIVER && a === RIVER && b === RIVER) return "road_water_lone";
	if (r === ROAD && b === ROAD && l === RIVER && a === RIVER) return "road_water5_corner";
	if (l === ROAD && b === ROAD && r === RIVER && a === RIVER) return "road_water6_corner";
	if (a === ROAD && l === ROAD && b === RIVER && r === RIVER) return "road_water7_corner";
	if (r === ROAD && a === ROAD && l === RIVER && b === RIVER) return "road_water8_corner";
	if (a === RIVER && b === RIVER) return "road_water_horizontal";
	if (l === RIVER && r === RIVER) return "road_water_vertical";
	if (a === RIVER && b === ROAD) return "road_water1";
	if (r === RIVER && l === ROAD) return "road_water2";
	if (b === RIVER && a === ROAD) return "road_water3";
	if (l === RIVER && r === ROAD) return "road_water4";
	if (r === ROAD && b === ROAD && a === ROAD && (ar === ROAD || br === ROAD)) return "road_side1";
	if (l === ROAD && r === ROAD && b === ROAD && (bl === ROAD || br === ROAD)) return "road_side2";
	if (l === ROAD && a === ROAD && b === ROAD && (bl === ROAD || al === ROAD)) return "road_side3";
	if (l === ROAD && r === ROAD && a === ROAD && (ar === ROAD || al === ROAD)) return "road_side4";
	if (l === ROAD && r === ROAD && b === ROAD) return "road_t1";
	if (l === ROAD && a === ROAD && b === ROAD) return "road_t2";
	if (l === ROAD && r === ROAD && a === ROAD) return "road_t3";
	if (r === ROAD && a === ROAD && b === ROAD) return "road_t4";
	if (b === ROAD && r === ROAD && br === ROAD) return "road_corner5_solid";
	if (b === ROAD && l === ROAD && bl === ROAD) return "road_corner6_solid";
	if (a === ROAD && l === ROAD && al === ROAD) return "road_corner7_solid";
	if (a === ROAD && r === ROAD && ar === ROAD) return "road_corner8_solid";
	if (b === ROAD && r === ROAD) return "road_corner1";
	if (b === ROAD && l === ROAD) return "road_corner2";
	if (a === ROAD && l === ROAD) return "road_corner3";
	if (a === ROAD && r === ROAD) return "road_corner4";
	if (r === ROAD || l === ROAD) return "road_horizontal";
	if (a === ROAD || b === ROAD) return "road_vertical";
	return "road_solid";
}

function calc_boat(al, a, ar, l, r, bl, b, br) {
	[al, a, ar, l, r, bl, b, br] = [al, a, ar, l, r, bl, b, br].map(water_to_river);
	if (a !== RIVER && l !== RIVER) return "boat5";
	if (a !== RIVER && r !== RIVER) return "boat6";
	if (b !== RIVER && r !== RIVER) return "boat7";
	if (b !== RIVER && l !== RIVER) return "boat4";
	if (l !== RIVER) return "boat2";
	if (r !== RIVER) return "boat3";
	if (b !== RIVER) return "boat0";
	return "boat1";
}

function calc_building(al, a, ar, l, r, bl, b, br) {
	let half = t => t === HALFBUILDING ? BUILDING : t;
	[al, a, ar, l, r, bl, b, br] = [al, a, ar, l, r, bl, b, br].map(half);
	let A = a === BUILDING, AL = al === BUILDING, AR = ar === BUILDING;
	let L = l === BUILDING, R = r === BUILDING;
	let B = b === BUILDING, BL = bl === BUILDING, BR = br === BUILDING;
	if (AL && A && AR && L && R && BL && B && BR) return "building_solid";
	if (R && A && B && L && !AR && !AL && !BR && !BL) return "building_cross";
	if (R && A && B && L && !AR && !AL && !BR && BL) return "building_most1";
	if (R && A && B && L && !AR && AL && !BR && !BL) return "building_most2";
	if (R && A && B && L && !AR && !AL && BR && !BL) return "building_most3";
	if (R && A && B && L && AR && !AL && !BR && !BL) return "building_most4";
	if (AL && A && L && R && BL && B && BR) return "building_sidecorn13";
	if (A && AR && L && R && BL && B && BR) return "building_sidecorn14";
	if (AL && A && AR && L && R && BL && B) return "building_sidecorn15";
	if (AL && A && AR && L && R && B && BR) return "building_sidecorn16";
	if (L && R && A && B && AR && BL && !AL && !BR) return "building_twist1";
	if (L && R && A && B && BR && AL && !AR && !BL) return "building_twist2";
	if (A && L && R && B && BR && AR) return "building_sidecorn5";
	if (A && L && R && B && BL && AL) return "building_sidecorn6";
	if (A && L && R && B && BL && BR) return "building_sidecorn7";
	if (A && L && R && B && AL && AR) return "building_sidecorn8";
	if (A && B && L && !R && BL && !AL) return "building_sidecorn9";
	if (A && B && R && BR && !L && !AR) return "building_sidecorn10";
	if (A && B && R && AR && !BR) return "building_sidecorn11";
	if (A && B && L && AL && !BL) return "building_sidecorn12";
	if (R && A && L && !B && !AL && !AR) return "building_t1";
	if (R && B && L && !BL && !BR) return "building_t2";
	if (R && A && B && !AR && !BR) return "building_t3";
	if (B && A && L && !AL && !BL) return "building_t4";
	if (L && R && A && AR && !AL) return "building_sidecorn1";
	if (L && R && A && AL && !AR) return "building_sidecorn2";
	if (L && R && B && BL && !BR) return "building_sidecorn3";
	if (L && R && B && !A && BR && !BL) return "building_sidecorn4";
	if (R && A && B) return "building_side1";
	if (L && A && B) return "building_side2";
	if (R && L && B) return "building_side3";
	if (R && A && L) return "building_side4";
	if (R && B && BR) return "building_corner1";
	if (L && B && BL) return "building_corner2";
	if (R && A && AR) return "building_corner3";
	if (L && A && AL) return "building_corner4";
	if (R && B) return "building_l1";
	if (L && B) return "building_l2";
	if (R && A) return "building_l3";
	if (L && A) return "building_l4";
	if (L && R) return "building_horizontal";
	if (A && B) return "building_vertical";
	if (R) return "building_horzend1";
	if (L) return "building_horzend2";
	if (B) return "building_vertend1";
	if (A) return "building_vertend2";
	return "building_single";
}

function calc_river(al, a, ar, l, r, bl, b, br) {
	/* the diagonals are unused, as in the original */
	[a, l, r, b] = [a, l, r, b].map(water_to_river);
	let land = t => t !== RIVER && t !== ROAD;
	if (land(a) && land(b) && land(r) && land(l)) return "river_surround";
	/* Deviation from screencalc.c: the end tests there accept only RIVER
	 * on the open side, so a lone river square touching a single road
	 * fell through to a corner tile. Accept ROAD too, like every other
	 * test in the chain does. */
	if (land(a) && land(b) && !land(r) && land(l)) return "river_end1";
	if (land(a) && land(b) && land(r) && !land(l)) return "river_end2";
	if (land(a) && !land(b) && land(r) && land(l)) return "river_end3";
	if (!land(a) && land(b) && land(r) && land(l)) return "river_end4";
	if (land(a) && land(l)) return "river_corner1";
	if (land(a) && land(r)) return "river_corner2";
	if (land(b) && land(l)) return "river_corner3";
	if (land(b) && land(r)) return "river_corner4";
	if (land(b) && land(a)) return "river_side1";
	if (land(l) && land(r)) return "river_side2";
	if (land(l)) return "river_oneside1";
	if (land(b)) return "river_oneside2";
	if (land(r)) return "river_oneside3";
	if (land(a)) return "river_oneside4";
	return "river_solid";
}

function calc_deep_sea(al, a, ar, l, r, bl, b, br) {
	let boat = t => t === BOAT ? RIVER : t;
	[al, a, ar, l, r, bl, b, br] = [al, a, ar, l, r, bl, b, br].map(boat);
	if (al !== DEEP_SEA && a !== DEEP_SEA && l !== DEEP_SEA && r === DEEP_SEA && b === DEEP_SEA) return "deep_sea_corner1";
	if (ar !== DEEP_SEA && a !== DEEP_SEA && r !== DEEP_SEA && l === DEEP_SEA && b === DEEP_SEA) return "deep_sea_corner2";
	if (br !== DEEP_SEA && b !== DEEP_SEA && r !== DEEP_SEA && l === DEEP_SEA && a === DEEP_SEA) return "deep_sea_corner4";
	if (bl !== DEEP_SEA && b !== DEEP_SEA && l !== DEEP_SEA && r === DEEP_SEA && a === DEEP_SEA) return "deep_sea_corner3";
	if (l === RIVER && r === DEEP_SEA) return "deep_sea_side1";
	if (b === RIVER && a === DEEP_SEA) return "deep_sea_side2";
	if (a === RIVER && b === DEEP_SEA) return "deep_sea_side3";
	if (r === RIVER && l === DEEP_SEA) return "deep_sea_side4";
	return "deep_sea";
}

function calc_forest(al, a, ar, l, r, bl, b, br) {
	/* the diagonals are unused, as in the original */
	let A = a === FOREST, L = l === FOREST, R = r === FOREST, B = b === FOREST;
	if (!A && !L && R && B) return "forest_bottomright";
	if (!A && L && !R && B) return "forest_bottomleft";
	if (A && L && !R && !B) return "forest_aboveleft";
	if (A && !L && R && !B) return "forest_aboveright";
	if (A && !L && !R && !B) return "forest_above";
	if (!A && !L && !R && B) return "forest_below";
	if (!A && L && !R && !B) return "forest_left";
	if (!A && !L && R && !B) return "forest_right";
	if (!A && !B && !L && !R) return "forest_single";
	return "forest";
}

/* Sprite name (sans .png) for the tile at (x, y). */
function name_for(grid, x, y) {
	let t = grid[y * MAP_SIZE + x];
	if (t >= 10 && t <= 15) t -= 8; /* mined: base terrain look, mine drawn on top */
	switch (t) {
		case 2: return "swamp";
		case 3: return "crater";
		case 6: return "rubble";
		case 7: return "grass";
		case HALFBUILDING: return "shot_building";
	}
	let al = norm_at(grid, x - 1, y - 1), a = norm_at(grid, x, y - 1), ar = norm_at(grid, x + 1, y - 1);
	let l = norm_at(grid, x - 1, y), r = norm_at(grid, x + 1, y);
	let bl = norm_at(grid, x - 1, y + 1), b = norm_at(grid, x, y + 1), br = norm_at(grid, x + 1, y + 1);
	switch (t) {
		case BUILDING: return calc_building(al, a, ar, l, r, bl, b, br);
		case RIVER: return calc_river(al, a, ar, l, r, bl, b, br);
		case ROAD: return calc_road(al, a, ar, l, r, bl, b, br);
		case FOREST: return calc_forest(al, a, ar, l, r, bl, b, br);
		case BOAT: return calc_boat(al, a, ar, l, r, bl, b, br);
		case DEEP_SEA: return calc_deep_sea(al, a, ar, l, r, bl, b, br);
	}
	return "deep_sea"; /* unknown code: show sea rather than nothing */
}

/* Every sprite the functions above can name, plus the mine overlay. */
const NAMES = (() => {
	let n = ["grass", "swamp", "crater", "rubble", "shot_building", "mine",
		"forest", "forest_single", "forest_above", "forest_below", "forest_left", "forest_right",
		"forest_aboveleft", "forest_aboveright", "forest_bottomleft", "forest_bottomright",
		"river_solid", "river_surround", "river_side1", "river_side2",
		"deep_sea", "road_solid", "road_crossroads", "road_horizontal", "road_vertical",
		"road_water_horizontal", "road_water_vertical", "road_water_lone",
		"building_solid", "building_single", "building_cross", "building_horizontal", "building_vertical",
		"building_twist1", "building_twist2",
		"building_horzend1", "building_horzend2", "building_vertend1", "building_vertend2"];
	let range = (prefix, lo, hi, suffix = "") => {
		for (let i = lo; i <= hi; i++) n.push(prefix + i + suffix);
	};
	range("boat", 0, 7);
	range("river_corner", 1, 4); range("river_end", 1, 4); range("river_oneside", 1, 4);
	range("deep_sea_corner", 1, 4); range("deep_sea_side", 1, 4);
	range("road_corner", 1, 4); range("road_corner", 5, 8, "_solid");
	range("road_side", 1, 4); range("road_t", 1, 4);
	range("road_water", 1, 4); range("road_water", 5, 8, "_corner");
	range("building_corner", 1, 4); range("building_l", 1, 4); range("building_t", 1, 4);
	range("building_side", 1, 4); range("building_sidecorn", 1, 16); range("building_most", 1, 4);
	return n;
})();

/* ---------- atlas (browser only) ---------- */
let atlas = null;
let atlas_x = new Map(); /* name -> x offset of its 16×16 cell in the atlas */
let ready = false;

/* Load every sprite into a single-row atlas canvas; on_ready fires once,
 * after the last file settles. base is the PNG directory, relative to the
 * page. A missing or broken file just leaves its tiles on the flat-colour
 * underlay. */
function load(on_ready, base = "sprites/") {
	if (atlas) return;
	atlas = document.createElement("canvas");
	atlas.width = NAMES.length * TILE;
	atlas.height = TILE;
	let actx = atlas.getContext("2d");
	let remaining = NAMES.length;
	let settle = () => {
		if (--remaining === 0) {
			ready = true;
			on_ready();
		}
	};
	NAMES.forEach((name, i) => {
		let img = new Image();
		img.addEventListener("load", () => {
			/* Explicit source and destination rects: a decode that comes back
			 * larger than the file (a browser-side image "enhancement") then
			 * squashes into its own cell instead of spilling over the next. */
			actx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, i * TILE, 0, TILE, TILE);
			atlas_x.set(name, i * TILE);
			settle();
		});
		img.addEventListener("error", settle);
		img.src = base + name + ".png";
	});
}

/* Non-integer device-pixel scales (e.g. zoom 24 on a 1× display = 1.5×)
 * make nearest-neighbour art lumpy: pixels come out alternately 1 and 2
 * screen pixels wide. The fix is "sharp bilinear": nearest-upscale the
 * atlas to the next integer multiple once, then let the canvas bilinear-
 * filter that down — the downscale is always in (0.5, 1], so pixels stay
 * even with only slight softening. Prescaled atlases are cached per factor. */
let scaled_atlases = new Map(); /* factor -> canvas */

function atlas_at(factor) {
	if (factor === 1) return atlas;
	let big = scaled_atlases.get(factor);
	if (!big) {
		big = document.createElement("canvas");
		big.width = atlas.width * factor;
		big.height = atlas.height * factor;
		let bctx = big.getContext("2d");
		bctx.imageSmoothingEnabled = false;
		bctx.drawImage(atlas, 0, 0, big.width, big.height);
		scaled_atlases.set(factor, big);
	}
	return big;
}

/* Integer factor to nearest-prescale 16px art by before drawing it at the
 * given zoom: 1 (draw the native art with smoothing off) when the art
 * lands on whole device pixels, else the next integer above the scale.
 * The display's ratio applies unless the caller renders at another (the
 * video export always draws at 1). */
function prescale_factor(z, dpr) {
	if (dpr === undefined) {
		dpr = (typeof devicePixelRatio !== "undefined") ? devicePixelRatio : 1;
	}
	let scale = z * dpr / TILE;
	return Number.isInteger(scale) ? 1 : Math.ceil(scale);
}

/* Draw terrain and mine sprites over every visible map tile. Terrain can be
 * suppressed independently; mine overlays still draw from the same atlas.
 * Destination rects are rounded per-edge so adjacent tiles share edges
 * exactly (no seams at any zoom). Returns false until the atlas is ready. */
function draw_view(ctx, grid, view, w, h, draw_terrain = true, dpr = undefined) {
	if (!ready) return false;
	let z = view.zoom;
	let factor = prescale_factor(z, dpr);
	let src = atlas_at(factor);
	let st = TILE * factor;
	let smooth_prev = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = factor > 1;
	let tx0 = Math.max(0, Math.floor(view.ox));
	let ty0 = Math.max(0, Math.floor(view.oy));
	let tx1 = Math.min(MAP_SIZE, Math.ceil(view.ox + w / z));
	let ty1 = Math.min(MAP_SIZE, Math.ceil(view.oy + h / z));
	let mine_x = atlas_x.get("mine");
	for (let ty = ty0; ty < ty1; ty++) {
		let y0 = Math.round((ty - view.oy) * z);
		let y1 = Math.round((ty + 1 - view.oy) * z);
		for (let tx = tx0; tx < tx1; tx++) {
			let x0 = Math.round((tx - view.ox) * z);
			let x1 = Math.round((tx + 1 - view.ox) * z);
			if (draw_terrain) {
				let sx = atlas_x.get(name_for(grid, tx, ty));
				if (sx !== undefined) {
					ctx.drawImage(src, sx * factor, 0, st, st, x0, y0, x1 - x0, y1 - y0);
				}
			}
			let t = grid[ty * MAP_SIZE + tx];
			if (t >= 10 && t <= 15 && mine_x !== undefined) {
				ctx.drawImage(src, mine_x * factor, 0, st, st, x0, y0, x1 - x0, y1 - y0);
			}
		}
	}
	ctx.imageSmoothingEnabled = smooth_prev;
	return true;
}

const BoloSprites = {
	MIN_ZOOM, NAMES, name_for, load, draw_view, prescale_factor,
	get ready() { return ready; },
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloSprites;
} else {
	window.BoloSprites = BoloSprites;
}

})();
