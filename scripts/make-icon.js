const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* Иконка приложения собирается кодом, без картинок в репозитории.
   Рисуем скруглённый квадрат с тёплым градиентом и точкой в центре, пакуем
   в PNG, а PNG кладём внутрь контейнера .ico — Windows Vista и новее такой
   формат понимают, а нам не нужен ни один внешний инструмент. */

const S = 256;

function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // фильтр строки: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит на канал, RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}

// Скруглённый квадрат: расстояние до границы считаем по той же формуле,
// что и в шейдерах, — так край получается ровным и сглаженным
function draw() {
  const px = Buffer.alloc(S * S * 4);
  const R = S * 0.22, half = S / 2 - S * 0.06;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.abs(x - S / 2) - half + R;
    const dy = Math.abs(y - S / 2) - half + R;
    const d = Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - R;
    const a = Math.max(0, Math.min(1, 0.5 - d));
    const t = y / S;
    let r = 217 - t * 40, g = 119 + t * 20, b = 87 + t * 60;
    // Точка в центре — «глаз» помощника
    const cd = Math.hypot(x - S / 2, y - S / 2) - S * 0.11;
    const dot = Math.max(0, Math.min(1, 0.5 - cd));
    r = r * (1 - dot) + 18 * dot; g = g * (1 - dot) + 24 * dot; b = b * (1 - dot) + 38 * dot;
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(a * 255);
  }
  return px;
}

const body = png(draw(), S);
const head = Buffer.alloc(6 + 16);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ico, одна картинка
// Запись каталога: 6 — ширина, 7 — высота (0 значит 256), 8 — палитра,
// 9 — резерв, 10 — плоскости, 12 — бит на пиксель, 14 — размер, 18 — смещение
head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0;
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(body.length, 14); head.writeUInt32LE(head.length, 18);

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, body]));
fs.writeFileSync(path.join(out, 'icon.png'), body);
console.log('иконка собрана:', body.length + head.length, 'байт');
