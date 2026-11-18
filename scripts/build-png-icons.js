'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const iconsDir = path.resolve('public', 'icons');
const svgPath = path.join(iconsDir, 'icon.svg');
const svgContent = fs.readFileSync(svgPath, 'utf8');

// Render 512x512 with Chrome headless
const htmlPath = path.join(iconsDir, '_render_tmp.html');
const out512 = path.join(iconsDir, 'icon-512x512.png');

fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 512px; height: 512px; overflow: hidden; background: transparent; }
    svg { width: 512px; height: 512px; display: block; }
  </style>
</head>
<body>
  ${svgContent}
</body>
</html>`);

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
execSync(`"${chromePath}" --headless --disable-gpu --default-background-color=00000000 --window-size=512,512 --screenshot="${out512}" "${fileUrl}"`, { stdio: 'inherit' });
fs.unlinkSync(htmlPath);

// High-quality downsampling to all other sizes
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}
function makeChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcVal = crc32(Buffer.concat([t, data]));
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, t, data, crc]);
}

function decodePngRgba(buf) {
  let pos = 8;
  let ihdr = null;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    pos += 12 + len;
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
  const { width, height } = ihdr;
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const filter = decompressed[y * stride];
    const prevRow = (y - 1) * width * 4;
    const currRow = y * width * 4;

    for (let x = 0; x < width * 4; x++) {
      const raw = decompressed[y * stride + 1 + x];
      let val = raw;
      const a = (x >= 4) ? pixels[currRow + x - 4] : 0;
      const b = (y > 0) ? pixels[prevRow + x] : 0;
      const c = (x >= 4 && y > 0) ? pixels[prevRow + x - 4] : 0;

      if (filter === 0) val = raw;
      else if (filter === 1) val = (raw + a) & 0xFF;
      else if (filter === 2) val = (raw + b) & 0xFF;
      else if (filter === 3) val = (raw + Math.floor((a + b) / 2)) & 0xFF;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (raw + pr) & 0xFF;
      }
      pixels[currRow + x] = val;
    }
  }
  return { width, height, pixels };
}

function resizeRgba(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const syStart = dy * yRatio, syEnd = (dy + 1) * yRatio;
    const sy0 = Math.floor(syStart), sy1 = Math.min(srcH - 1, Math.floor(syEnd));

    for (let dx = 0; dx < dstW; dx++) {
      const sxStart = dx * xRatio, sxEnd = (dx + 1) * xRatio;
      const sx0 = Math.floor(sxStart), sx1 = Math.min(srcW - 1, Math.floor(sxEnd));

      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        const yw = Math.min(sy + 1, syEnd) - Math.max(sy, syStart);
        if (yw <= 0) continue;
        for (let sx = sx0; sx <= sx1; sx++) {
          const xw = Math.min(sx + 1, sxEnd) - Math.max(sx, sxStart);
          if (xw <= 0) continue;
          const w = xw * yw;
          const idx = (sy * srcW + sx) * 4;
          rSum += src[idx] * w;
          gSum += src[idx + 1] * w;
          bSum += src[idx + 2] * w;
          aSum += src[idx + 3] * w;
          wSum += w;
        }
      }
      const dstIdx = (dy * dstW + dx) * 4;
      dst[dstIdx] = Math.round(rSum / wSum);
      dst[dstIdx + 1] = Math.round(gSum / wSum);
      dst[dstIdx + 2] = Math.round(bSum / wSum);
      dst[dstIdx + 3] = Math.round(aSum / wSum);
    }
  }
  return dst;
}

function encodePng(pixels, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const IHDR = makeChunk('IHDR', ihdr);

  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0;
    pixels.copy(rawData, y * rowSize + 1, y * width * 4, (y + 1) * width * 4);
  }
  const IDAT = makeChunk('IDAT', zlib.deflateSync(rawData, { level: 9 }));
  const IEND = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, IHDR, IDAT, IEND]);
}

const srcBuf = fs.readFileSync(out512);
const { width: srcW, height: srcH, pixels: srcPixels } = decodePngRgba(srcBuf);

const otherSizes = [72, 96, 128, 144, 152, 192, 384];
for (const s of otherSizes) {
  const resized = resizeRgba(srcPixels, srcW, srcH, s, s);
  const png = encodePng(resized, s, s);
  fs.writeFileSync(path.join(iconsDir, `icon-${s}x${s}.png`), png);
  console.log(`Generated icon-${s}x${s}.png (${png.length} bytes)`);
}
console.log('All sizes generated from exact icon.svg!');
