/* Minimal zip reader: enough to pull the members out of a WinBolo .wbv
 * (a zip written by minizip holding log.dat and, in newer versions,
 * attribution.trk). Entries are located from the central directory, so a
 * data descriptor after the member data does not matter. Only stored and
 * deflated members are understood; the deflate payload is returned
 * compressed for the caller to inflate (see inflate.js), keeping this file
 * free of any decompression code. No zip64, no encryption, no multi-disk
 * archives: a replay is a few MB. */
"use strict";
(function () {

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const END_OF_CENTRAL_MIN = 22;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000; }

function latin1(b, p, n) {
	let s = "";
	for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
	return s;
}

/* Offset of the end-of-central-directory record: it sits at the end of
 * the file, followed only by its own comment (at most 65535 bytes). */
function find_end_of_central(bytes) {
	let lo = Math.max(0, bytes.length - END_OF_CENTRAL_MIN - 0xffff);
	for (let p = bytes.length - END_OF_CENTRAL_MIN; p >= lo; p--) {
		if (u32(bytes, p) === END_OF_CENTRAL && p + END_OF_CENTRAL_MIN + u16(bytes, p + 20) <= bytes.length) return p;
	}
	return -1;
}

function is_zip(bytes) {
	return bytes.length >= 4 && u32(bytes, 0) === LOCAL_HEADER;
}

/* Every member of the archive, in central-directory order:
 *   { name, method, crc32, compressed_size, size, data, comment }
 * where data is a view of the member's bytes as stored (compressed when
 * method is 8). The archive comment comes back as .comment on the array. */
function entries(bytes) {
	if (bytes.length < END_OF_CENTRAL_MIN) throw new Error("not a zip file (too short)");
	let end = find_end_of_central(bytes);
	if (end < 0) throw new Error("not a zip file (no end-of-central-directory record)");
	let count = u16(bytes, end + 10);
	let dir_size = u32(bytes, end + 12);
	let dir_offset = u32(bytes, end + 16);
	let comment_len = u16(bytes, end + 20);
	if (dir_offset + dir_size > end) throw new Error("zip central directory out of range");

	let out = [];
	let p = dir_offset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > bytes.length || u32(bytes, p) !== CENTRAL_HEADER) throw new Error("zip central directory is damaged");
		let method = u16(bytes, p + 10);
		let crc32 = u32(bytes, p + 16);
		let compressed_size = u32(bytes, p + 20);
		let size = u32(bytes, p + 24);
		let name_len = u16(bytes, p + 28);
		let extra_len = u16(bytes, p + 30);
		let entry_comment_len = u16(bytes, p + 32);
		let local_offset = u32(bytes, p + 42);
		let name = latin1(bytes, p + 46, name_len);
		let comment = latin1(bytes, p + 46 + name_len + extra_len, entry_comment_len);
		p += 46 + name_len + extra_len + entry_comment_len;

		if (local_offset + 30 > bytes.length || u32(bytes, local_offset) !== LOCAL_HEADER) {
			throw new Error(`zip member ${name}: bad local header`);
		}
		/* the local header's own name and extra field can differ in length
		 * from the central directory's copy, so measure them here */
		let data_start = local_offset + 30 + u16(bytes, local_offset + 26) + u16(bytes, local_offset + 28);
		if (data_start + compressed_size > bytes.length) throw new Error(`zip member ${name}: data out of range`);
		if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error(`zip member ${name}: unsupported compression method ${method}`);
		out.push({ name, method, crc32, compressed_size, size, comment,
			data: bytes.subarray(data_start, data_start + compressed_size) });
	}
	out.comment = latin1(bytes, end + 22, comment_len);
	return out;
}

/* CRC-32 of a byte array, for checking an inflated member against the
 * value the archive recorded. */
let crc_table = null;

function crc32(bytes) {
	if (!crc_table) {
		crc_table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
			crc_table[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = crc_table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const WinBoloZip = { METHOD_STORE, METHOD_DEFLATE, is_zip, entries, crc32 };

if (typeof module !== "undefined" && module.exports) {
	module.exports = WinBoloZip;
} else {
	window.WinBoloZip = WinBoloZip;
}

})();
