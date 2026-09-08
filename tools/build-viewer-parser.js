/* Generates viewer/logparse.js from the three parser files in src/, so the
 * viewer directory is self-contained (the Tauri build embeds it, and the
 * web page serves it alone). Run after editing anything in src/:
 *
 *   node tools/build-viewer-parser.js
 *
 * test/test.js fails if the committed build is stale. Each source file is
 * a self-registering classic script, so the build is their concatenation. */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const SOURCES = ["zip.js", "inflate.js", "parse.js"];

function build() {
	let out = `/* GENERATED FILE - do not edit. Built from ${SOURCES.map(f => "src/" + f).join(", ")}
 * by tools/build-viewer-parser.js, for the viewer. Edit src/ and rebuild. */
`;
	for (let f of SOURCES) {
		/* CRLF from a Windows checkout would make the build differ by platform */
		out += "\n" + fs.readFileSync(path.join(root, "src", f), "utf8").replace(/\r\n/g, "\n");
	}
	return out;
}

if (require.main === module) {
	fs.writeFileSync(path.join(root, "viewer", "logparse.js"), build());
	console.log("wrote viewer/logparse.js");
}

module.exports = { build };
