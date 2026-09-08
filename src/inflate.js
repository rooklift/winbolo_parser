/* Raw deflate decompression for the zip members of a .wbv, in whichever
 * environment the parser is running: Node's zlib when require() exists,
 * the browser's DecompressionStream otherwise (Chrome 103, Firefox 113,
 * Safari 16.4 and later; Electron and WebView2 have it). Both paths give
 * back a promise of the inflated bytes, so callers are written once. */
"use strict";
(function () {

const NODE = typeof module !== "undefined" && module.exports;

function inflate_raw(bytes) {
	if (NODE) {
		return new Promise((resolve, reject) => {
			try {
				resolve(new Uint8Array(require("zlib").inflateRawSync(bytes)));
			} catch (err) {
				reject(err);
			}
		});
	}
	if (typeof DecompressionStream === "undefined") {
		return Promise.reject(new Error("this browser cannot inflate zip members (no DecompressionStream)"));
	}
	let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Response(stream).arrayBuffer().then(ab => new Uint8Array(ab));
}

const WinBoloInflate = { inflate_raw };

if (NODE) {
	module.exports = WinBoloInflate;
} else {
	window.WinBoloInflate = WinBoloInflate;
}

})();
