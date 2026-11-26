import sharp from "sharp";

// Turns a plain white background into transparency, for images that lost their alpha channel
// (Telegram sends photos as JPEG with transparency flattened to white).
//
// Flood fill from the image border through near-white pixels, so white inside the subject
// (eyes, teeth, white fur enclosed by an outline) is kept. A thin band around the removed area
// gets partial alpha and has the white blended out of its colour, so edges stay smooth.

// Pixels this close to pure white count as background; JPEG noise keeps white from being exactly 255.
const WHITE_TOLERANCE = 32;
// Width in pixels of the soft edge between the subject and the removed background.
const EDGE_BAND = 2;
// Edge pixels at least this far from white stay fully opaque.
const EDGE_OPAQUE_AT = 140;

function distanceFromWhite(data: Uint8Array, i: number): number {
  return 255 - Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
}

// Share of border pixels that are near-white: a cheap "does this sit on a white background" check.
export async function whiteBorderRatio(input: string): Promise<number> {
  const { data, info } = await sharp(input).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  let white = 0;
  let total = 0;
  const check = (x: number, y: number) => {
    total++;
    if (distanceFromWhite(data, (y * w + x) * channels) <= WHITE_TOLERANCE) white++;
  };
  for (let x = 0; x < w; x++) {
    check(x, 0);
    check(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    check(0, y);
    check(w - 1, y);
  }
  return total ? white / total : 0;
}

export async function removeWhiteBackground(input: string, out: string): Promise<{ removedRatio: number }> {
  const { data, info } = await sharp(input).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;

  const dist = new Uint8Array(n);
  for (let p = 0; p < n; p++) dist[p] = distanceFromWhite(data, p * 4);

  // Flood fill the background from every border pixel.
  const background = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const visit = (p: number) => {
    if (background[p] === 0 && (dist[p] ?? 255) <= WHITE_TOLERANCE) {
      background[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++] ?? 0;
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < n - w) visit(p + w);
  }

  // Rings of subject pixels next to the background, 1 = touching it.
  const band = new Uint8Array(n);
  for (let level = 1; level <= EDGE_BAND; level++) {
    const near = (q: number) => background[q] === 1 || ((band[q] ?? 0) > 0 && (band[q] ?? 0) < level);
    for (let p = 0; p < n; p++) {
      if (background[p] === 1 || band[p] !== 0) continue;
      const x = p % w;
      if ((x > 0 && near(p - 1)) || (x < w - 1 && near(p + 1)) || (p >= w && near(p - w)) || (p < n - w && near(p + w))) {
        band[p] = level;
      }
    }
  }

  let removed = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (background[p] === 1) {
      data[i + 3] = 0;
      removed++;
      continue;
    }
    if (band[p] === 0) continue;
    const alpha = Math.min(1, Math.max(0, ((dist[p] ?? 255) - WHITE_TOLERANCE) / (EDGE_OPAQUE_AT - WHITE_TOLERANCE)));
    if (alpha >= 1) continue;
    data[i + 3] = Math.round(alpha * 255);
    if (alpha > 0) {
      // Undo the blend with white: c = a * colour + (1 - a) * 255.
      for (let c = 0; c < 3; c++) {
        const value = data[i + c] ?? 255;
        data[i + c] = Math.max(0, Math.round(255 - (255 - value) / alpha));
      }
    }
  }

  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(out);
  return { removedRatio: removed / n };
}
