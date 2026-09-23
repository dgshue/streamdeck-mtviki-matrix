// Generates the plugin's PNG assets. Run with `node tools/make-icons.mjs`.
// Hand-rolled encoder so the repo needs no image dependency for six flat icons.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SS = 4; // supersampling factor for smooth edges

function canvas(w, h) {
	return { w, h, px: new Float32Array(w * SS * h * SS * 4) };
}

function paint(c, shape, [r, g, b, a = 1]) {
	const W = c.w * SS;
	const H = c.h * SS;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			// Sample at pixel centre in 0..1 unit space.
			if (!shape((x + 0.5) / W, (y + 0.5) / H)) continue;
			const i = (y * W + x) * 4;
			const src = [r, g, b];
			for (let k = 0; k < 3; k++) c.px[i + k] = c.px[i + k] * (1 - a) + src[k] * a;
			c.px[i + 3] = c.px[i + 3] * (1 - a) + 255 * a;
		}
	}
}

const roundRect = (x0, y0, x1, y1, rad) => (x, y) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
	const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
	const dx = x - cx;
	const dy = y - cy;
	return dx * dx + dy * dy <= rad * rad;
};

/** Isosceles triangle pointing "up" or "down" within the given box. */
const tri = (x0, y0, x1, y1, dir) => (x, y) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const t = dir === "up" ? (y - y0) / (y1 - y0) : (y1 - y) / (y1 - y0);
	const half = ((x1 - x0) / 2) * t;
	const mid = (x0 + x1) / 2;
	return Math.abs(x - mid) <= half;
};

function downscale(c) {
	const out = Buffer.alloc(c.w * c.h * 4);
	const W = c.w * SS;
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			let acc = [0, 0, 0, 0];
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
					for (let k = 0; k < 4; k++) acc[k] += c.px[i + k];
				}
			}
			const o = (y * c.w + x) * 4;
			for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / (SS * SS));
		}
	}
	return out;
}

function png(c) {
	const rgba = downscale(c);
	const raw = Buffer.alloc((c.w * 4 + 1) * c.h);
	for (let y = 0; y < c.h; y++) {
		raw[y * (c.w * 4 + 1)] = 0; // filter type: none
		rgba.copy(raw, y * (c.w * 4 + 1) + 1, y * c.w * 4, (y + 1) * c.w * 4);
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(c.w, 0);
	ihdr.writeUInt32BE(c.h, 4);
	ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

let TABLE = null;
function crc32(buf) {
	if (!TABLE) {
		TABLE = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			TABLE[n] = c;
		}
	}
	let crc = -1;
	for (const b of buf) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return crc ^ -1;
}

const BG = [26, 29, 33];
const FG = [235, 238, 242];
const ACCENT = [0, 168, 232];
const ACCENT2 = [255, 170, 40];

/** Two screens with up/down arrows between them: "swap these two". */
function swapArt(c, withBg) {
	if (withBg) paint(c, roundRect(0, 0, 1, 1, 0.14), BG);
	paint(c, roundRect(0.2, 0.1, 0.8, 0.32, 0.04), FG);
	paint(c, roundRect(0.2, 0.68, 0.8, 0.9, 0.04), FG);
	paint(c, tri(0.24, 0.38, 0.46, 0.52, "up"), ACCENT);
	paint(c, roundRect(0.31, 0.5, 0.39, 0.64, 0.0), ACCENT);
	paint(c, tri(0.54, 0.48, 0.76, 0.62, "down"), ACCENT2);
	paint(c, roundRect(0.61, 0.36, 0.69, 0.5, 0.0), ACCENT2);
}

/** One source fanning out to two screens: "route this input there". */
function routeArt(c, withBg) {
	if (withBg) paint(c, roundRect(0, 0, 1, 1, 0.14), BG);
	paint(c, roundRect(0.08, 0.4, 0.34, 0.6, 0.04), ACCENT);
	paint(c, roundRect(0.34, 0.47, 0.58, 0.53, 0.0), FG);
	paint(c, roundRect(0.52, 0.2, 0.58, 0.53, 0.0), FG);
	paint(c, roundRect(0.52, 0.47, 0.58, 0.8, 0.0), FG);
	paint(c, roundRect(0.66, 0.12, 0.94, 0.34, 0.04), FG);
	paint(c, roundRect(0.66, 0.66, 0.94, 0.88, 0.04), FG);
}

/** Straight parallel runs, left to right: "everything back where it belongs". */
function identityArt(c, withBg) {
	if (withBg) paint(c, roundRect(0, 0, 1, 1, 0.14), BG);
	const rows = [0.22, 0.5, 0.78];
	for (const y of rows) {
		paint(c, roundRect(0.08, y - 0.08, 0.26, y + 0.08, 0.03), ACCENT);
		paint(c, roundRect(0.26, y - 0.03, 0.74, y + 0.03, 0.0), FG);
		paint(c, roundRect(0.74, y - 0.08, 0.92, y + 0.08, 0.03), FG);
	}
}

/** A 2x2 of screens with two dark: "this arrangement, some blanked". */
function layoutArt(c, withBg) {
	if (withBg) paint(c, roundRect(0, 0, 1, 1, 0.14), BG);
	const cells = [
		[0.1, 0.12, 0.47, 0.46, true],
		[0.53, 0.12, 0.9, 0.46, false],
		[0.1, 0.54, 0.47, 0.88, true],
		[0.53, 0.54, 0.9, 0.88, false],
	];
	for (const [x0, y0, x1, y1, lit] of cells) {
		if (lit) {
			paint(c, roundRect(x0, y0, x1, y1, 0.04), ACCENT);
		} else {
			// Outline only, to read as a screen that is off rather than missing.
			paint(c, roundRect(x0, y0, x1, y1, 0.04), [90, 96, 104]);
			paint(c, roundRect(x0 + 0.045, y0 + 0.045, x1 - 0.045, y1 - 0.045, 0.02), BG);
		}
	}
}

const jobs = [
	["com.dgshue.mtviki.sdPlugin/imgs/plugin/marketplace.png", 288, swapArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/plugin/category-icon.png", 28, swapArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/plugin/category-icon@2x.png", 56, swapArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/swap/icon.png", 20, swapArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/swap/icon@2x.png", 40, swapArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/swap/key.png", 72, swapArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/swap/key@2x.png", 144, swapArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/layout/icon.png", 20, layoutArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/layout/icon@2x.png", 40, layoutArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/layout/key.png", 72, layoutArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/layout/key@2x.png", 144, layoutArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/identity/icon.png", 20, identityArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/identity/icon@2x.png", 40, identityArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/identity/key.png", 72, identityArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/identity/key@2x.png", 144, identityArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/route/icon.png", 20, routeArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/route/icon@2x.png", 40, routeArt, false],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/route/key.png", 72, routeArt, true],
	["com.dgshue.mtviki.sdPlugin/imgs/actions/route/key@2x.png", 144, routeArt, true],
];

for (const [path, size, art, withBg] of jobs) {
	const c = canvas(size, size);
	art(c, withBg);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, png(c));
	console.log(`${path} (${size}x${size})`);
}
