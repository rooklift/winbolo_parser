/* Assembles the Tauri app's web assets in ./www: the viewer's index.html,
 * every script and stylesheet it references, and the sprites. Tauri embeds
 * that directory into the executable at build time, so the copy leaves out
 * the Electron and build files that sit beside them in viewer/. Run by the
 * Tauri CLI as the beforeBuildCommand / beforeDevCommand hook. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let here = path.dirname(fileURLToPath(import.meta.url));
let viewer = path.resolve(here, "..");
let out = path.join(here, "www");

let html = fs.readFileSync(path.join(viewer, "index.html"), "utf8");
let referenced = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map(m => m[1]);
if (referenced.length === 0) {
	throw new Error("index.html references no scripts or stylesheets; the pattern above no longer matches it");
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(viewer, "index.html"), path.join(out, "index.html"));
for (let file of referenced) {
	fs.copyFileSync(path.join(viewer, file), path.join(out, file));
}
fs.cpSync(path.join(viewer, "sprites"), path.join(out, "sprites"), { recursive: true });

console.log(`staged index.html, ${referenced.length} referenced files and sprites/ into ${out}`);
