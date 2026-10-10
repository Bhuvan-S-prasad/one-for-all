// The desktop's wallpaper (ADR-0040), drawn at image build time so the image
// carries no binary assets: the app's dark background with a few rotated,
// rounded outlines in its lime and greys. Node built-ins only.
//
//   node wallpaper.mjs /usr/share/backgrounds/one-for-all.png

import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const W = 1600;
const H = 1000;
const out = process.argv[2] ?? "one-for-all.png";

const BG = [14, 14, 15]; // --background (dark)
const LIFT = [24, 25, 27]; // a soft light behind the centre
/** Outlines: centre, half-size, corner radius, stroke, colour, opacity. */
const SHAPES = [
  { cx: 0.62, cy: 0.5, h: 0.3, r: 0.06, w: 3, c: [212, 255, 58], a: 0.35 },
  { cx: 0.8, cy: 0.42, h: 0.26, r: 0.05, w: 2.5, c: [168, 168, 173], a: 0.16 },
  { cx: 0.08, cy: 0.3, h: 0.22, r: 0.05, w: 2.5, c: [168, 168, 173], a: 0.12 },
  { cx: 0.22, cy: 1.0, h: 0.2, r: 0.05, w: 2.5, c: [212, 255, 58], a: 0.14 },
  { cx: 0.36, cy: -0.05, h: 0.16, r: 0.04, w: 2, c: [168, 168, 173], a: 0.1 },
];

const S = Math.SQRT1_2;
/** Signed distance from (x, y) to a 45°-rotated rounded square. */
function distance(x, y, { cx, cy, h, r }) {
  const px = x - cx * W;
  const py = y - cy * H;
  const qx = Math.abs((px + py) * S) - (h * H - r * H);
  const qy = Math.abs((py - px) * S) - (h * H - r * H);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r * H;
}

const rows = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  const row = y * (W * 3 + 1);
  rows[row] = 0; // filter: none
  for (let x = 0; x < W; x += 1) {
    const glow = Math.max(0, 1 - Math.hypot((x - W * 0.6) / W, (y - H * 0.5) / H) * 1.6);
    const px = BG.map((b, i) => b + (LIFT[i] - b) * glow);
    for (const shape of SHAPES) {
      const d = Math.abs(distance(x, y, shape));
      const cover = Math.min(1, Math.max(0, shape.w / 2 + 0.5 - d)) * shape.a;
      if (cover > 0) for (let i = 0; i < 3; i += 1) px[i] += (shape.c[i] - px[i]) * cover;
    }
    const at = row + 1 + x * 3;
    rows[at] = px[0];
    rows[at + 1] = px[1];
    rows[at + 2] = px[2];
  }
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
