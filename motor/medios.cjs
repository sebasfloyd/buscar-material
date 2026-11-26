// Lectura de fotos y videos. Solo lee los originales: lo único que escribe son miniaturas en la carpeta de datos.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { dep, TMP, MINIATURAS, ES_WIN, ES_MAC } = require('./util.cjs');

const EXT_FOTO = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff']);
const EXT_HEIC = new Set(['heic', 'heif']);
const EXT_RAW = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'srw', 'pef']);
const EXT_PSD = new Set(['psd', 'psb']);
const EXT_VIDEO = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'mpg', 'wmv']);
// formatos que el navegador muestra tal cual en la vista rápida
const EXT_NAVEGADOR = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'mp4', 'm4v', 'webm', 'mov']);

const LADO_MINI = 384;
const LADO_MODELO = 256;
const MAX_PSD = 700 * 1024 * 1024;

function extDe(nombre) { return path.extname(nombre).slice(1).toLowerCase(); }
function tipoDe(nombre) {
  const e = extDe(nombre);
  if (EXT_FOTO.has(e) || EXT_HEIC.has(e) || EXT_RAW.has(e) || EXT_PSD.has(e)) return 'f';
  if (EXT_VIDEO.has(e)) return 'v';
  return null;
}

let _sharp = null;
function sharp() {
  if (!_sharp) { _sharp = dep('sharp'); _sharp.cache(false); }
  return _sharp;
}

let _exiftool = null;
function exiftool() {
  if (!_exiftool) _exiftool = new (dep('exiftool-vendored').ExifTool)({ maxProcs: 2, taskTimeoutMillis: 30000 });
  return _exiftool;
}
async function cerrar() { if (_exiftool) { try { await _exiftool.end(); } catch {} _exiftool = null; } }

function tmpNombre(ext) { return path.join(TMP, crypto.randomBytes(8).toString('hex') + '.' + ext); }

function correr(cmd, args, opciones = {}) {
  return new Promise((resolve) => {
    let err = '', out = '';
    let hijo;
    try { hijo = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opciones }); }
    catch (e) { return resolve({ codigo: -1, err: String(e), out: '' }); }
    const tope = setTimeout(() => { try { hijo.kill(); } catch {} }, opciones.espera || 120000);
    hijo.stdout.on('data', d => { if (out.length < 200000) out += d; });
    hijo.stderr.on('data', d => { if (err.length < 200000) err += d; });
    hijo.on('error', e => { clearTimeout(tope); resolve({ codigo: -1, err: String(e), out }); });
    hijo.on('close', codigo => { clearTimeout(tope); resolve({ codigo, err, out }); });
  });
}

// Devuelve { img: instancia de sharp ya orientada, limpiar() } para cualquier formato de foto admitido.
async function abrirFoto(ruta) {
  const e = extDe(ruta);
  const S = sharp();
  const base = { failOn: 'none', limitInputPixels: 1e9 };
  if (EXT_FOTO.has(e)) return { img: S(ruta, { ...base, pages: 1 }).rotate(), limpiar() {} };

  if (EXT_HEIC.has(e)) {
    try { // algunas compilaciones de sharp abren HEIC; la mayoría no
      const img = S(ruta, base); await img.metadata(); await img.clone().resize(8).raw().toBuffer();
      return { img: S(ruta, base).rotate(), limpiar() {} };
    } catch {}
    if (ES_MAC && !process.env.BUSCAR_SIN_SIPS) {
      const tmp = tmpNombre('jpg');
      const r = await correr('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2400', ruta, '--out', tmp]);
      if (r.codigo === 0 && fs.existsSync(tmp)) {
        // la conversión achica la foto: el tamaño real se le pregunta aparte al original
        let real = null;
        const g = await correr('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', ruta]);
        const mw = /pixelWidth: (\d+)/.exec(g.out), mh = /pixelHeight: (\d+)/.exec(g.out);
        if (mw && mh) real = { w: +mw[1], h: +mh[1] };
        return { img: S(tmp, base).rotate(), real, limpiar() { fs.rmSync(tmp, { force: true }); } };
      }
      fs.rmSync(tmp, { force: true });
    }
    const decodificar = dep('heic-decode');
    const { width, height, data } = await decodificar({ buffer: await fs.promises.readFile(ruta) });
    return { img: S(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } }), limpiar() {} };
  }

  if (EXT_RAW.has(e)) {
    const et = exiftool();
    const tmp = tmpNombre('jpg');
    let ok = false;
    for (const metodo of ['extractJpgFromRaw', 'extractPreview', 'extractThumbnail']) {
      try { await et[metodo](ruta, tmp); if (fs.existsSync(tmp) && fs.statSync(tmp).size > 2000) { ok = true; break; } } catch {}
      fs.rmSync(tmp, { force: true });
    }
    if (!ok) throw new Error('RAW sin vista previa embebida');
    let giro = 0, real = null;
    try {
      const t = await et.read(ruta, ['-n']);
      giro = ({ 3: 180, 6: 90, 8: 270 })[Number(t.Orientation)] || 0;
      const w = Number(t.ImageWidth), h = Number(t.ImageHeight); // la vista previa embebida suele ser más chica que la foto
      if (w > 0 && h > 0) real = giro === 90 || giro === 270 ? { w: h, h: w } : { w, h };
      const f = t.DateTimeOriginal || t.CreateDate; const ms = f ? Date.parse(String(f.rawValue || f).replace(/^(\d{4}):(\d\d):(\d\d) /, '$1-$2-$3T')) : 0;
      if (real && ms > 0) real.fecha = ms;
    } catch {}
    let img = S(tmp, base);
    const meta = await img.metadata();
    img = (meta.orientation && meta.orientation > 1) ? img.rotate() : (giro ? img.rotate(giro) : img);
    return { img, real, limpiar() { fs.rmSync(tmp, { force: true }); } };
  }

  if (EXT_PSD.has(e)) {
    const tam = (await fs.promises.stat(ruta)).size;
    if (tam > MAX_PSD) throw new Error('PSD demasiado pesado para generar miniatura');
    const { readPsd, initializeCanvas } = dep('ag-psd');
    // ag-psd pide un canvas; acá alcanza con darle dónde dejar los píxeles
    initializeCanvas(() => { throw new Error('PSD con capas que necesitan canvas'); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
    const psd = readPsd(await fs.promises.readFile(ruta), { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
    if (!psd.imageData) throw new Error('PSD sin imagen compuesta (guardalo con "maximizar compatibilidad")');
    const d = psd.imageData;
    return { img: S(Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength), { raw: { width: d.width, height: d.height, channels: 4 } }), limpiar() {} };
  }
  throw new Error('Formato no admitido');
}

// dHash de 64 bits (9x8 en grises) como 16 caracteres hexadecimales
async function dhash(S, rgba, info) {
  const g = await S(rgba, { raw: info }).flatten({ background: '#808080' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let b = 0;
    for (let x = 0; x < 8; x++) b = (b << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

// Entrada del modelo: 3x256x256, valores en [-1, 1]
async function tensorDesde(S, rgba, info) {
  let fondo = '#ffffff';
  if (info.channels === 4) { // un logo blanco transparente no se ve sobre blanco: se apoya sobre gris oscuro
    let suma = 0, n = 0;
    for (let i = 0; i < rgba.length; i += 16) { const a = rgba[i + 3]; if (a > 128) { suma += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; n++; } }
    if (n && suma / n > 200 && n < rgba.length / 16 * 0.9) fondo = '#333333';
  }
  const d = await S(rgba, { raw: info }).flatten({ background: fondo }).resize(LADO_MODELO, LADO_MODELO, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  const px = LADO_MODELO * LADO_MODELO;
  const t = new Float32Array(3 * px);
  for (let i = 0; i < px; i++) {
    t[i] = d[i * 3] / 127.5 - 1;
    t[px + i] = d[i * 3 + 1] / 127.5 - 1;
    t[2 * px + i] = d[i * 3 + 2] / 127.5 - 1;
  }
  return t;
}

// Color del borde de la miniatura: sirve para "sobre fondo negro". Devuelve [r, g, b, parejo 0-100].
function colorDeBorde(rgba, info) {
  const { width: w, height: h } = info, m = Math.max(2, Math.round(Math.min(w, h) * 0.07));
  const px = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x >= m && x < w - m && y >= m && y < h - m) continue;
    const i = (y * w + x) * 4, a = rgba[i + 3] / 255;
    px.push(rgba[i] * a + 255 * (1 - a), rgba[i + 1] * a + 255 * (1 - a), rgba[i + 2] * a + 255 * (1 - a));
  }
  const n = px.length / 3; if (!n) return null;
  // mediana por canal: aguanta que el producto toque un borde
  const canal = k => { const v = []; for (let i = k; i < px.length; i += 3) v.push(px[i]); v.sort((a, b) => a - b); return v[v.length >> 1]; };
  const r = canal(0), g = canal(1), b = canal(2);
  let cerca = 0;
  for (let i = 0; i < px.length; i += 3) if (Math.abs(px[i] - r) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - b) < 90) cerca++;
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(cerca / n * 100)];
}
async function colorDeMini(ruta) {
  const { data, info } = await sharp()(ruta).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return colorDeBorde(data, info);
}

function fechaExif(buf) {
  if (!buf) return 0;
  const m = buf.toString('latin1').match(/(19|20)\d\d:[01]\d:[0-3]\d [0-2]\d:[0-5]\d:[0-5]\d/g);
  if (!m) return 0;
  let mejor = 0;
  for (const s of m) {
    const t = Date.parse(s.replace(/^(\d+):(\d+):(\d+) /, '$1-$2-$3T'));
    if (t > 0 && (!mejor || t < mejor)) mejor = t;
  }
  return mejor;
}

// De una imagen ya abierta saca miniatura, entrada del modelo y huella. Decodifica el original una sola vez.
async function derivar(img, conTensor = true) {
  const S = sharp();
  const meta = await img.metadata().catch(() => ({}));
  const { data, info } = await img.clone().resize(LADO_MINI, LADO_MINI, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const crudo = { width: info.width, height: info.height, channels: 4 };
  const mini = await S(data, { raw: crudo }).webp({ quality: 76, alphaQuality: 80, effort: 3 }).toBuffer();
  let w = meta.width || info.width, h = meta.height || info.height;
  if (meta.orientation >= 5) [w, h] = [h, w];
  return {
    mini, w, h,
    tensor: conTensor ? await tensorDesde(S, data, crudo) : null,
    dh: await dhash(S, data, crudo),
    bc: colorDeBorde(data, crudo),
    fecha: fechaExif(meta.exif),
  };
}

async function procesarFoto(ruta) {
  const { img, real, limpiar } = await abrirFoto(ruta);
  try { const d = await derivar(img); if (real) { d.w = real.w; d.h = real.h; if (real.fecha) d.fecha = real.fecha; } return d; } finally { limpiar(); }
}

// La entrada del modelo desde una miniatura ya guardada o desde una imagen suelta (buscar por imagen)
async function tensorDeImagen(origen) {
  const S = sharp();
  const { data, info } = await S(origen, { failOn: 'none' }).rotate().resize(LADO_MINI, LADO_MINI, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return tensorDesde(S, data, { width: info.width, height: info.height, channels: 4 });
}

async function hashRapido(ruta, tam) {
  const h = crypto.createHash('sha1');
  const f = await fs.promises.open(ruta, 'r');
  try {
    const N = 262144;
    const a = Buffer.alloc(Math.min(N, tam));
    await f.read(a, 0, a.length, 0); h.update(a);
    if (tam > N * 2) { const b = Buffer.alloc(N); await f.read(b, 0, N, tam - N); h.update(b); }
  } finally { await f.close(); }
  h.update(String(tam));
  return h.digest('hex').slice(0, 20);
}

// ---------- miniaturas en disco ----------
function rutaMini(id, t) {
  const sub = String(id % 256).padStart(3, '0');
  return path.join(MINIATURAS, sub, t == null ? `${id}.webp` : `${id}_${t}.webp`);
}
async function guardarMini(id, t, buf) {
  const r = rutaMini(id, t);
  await fs.promises.mkdir(path.dirname(r), { recursive: true });
  await fs.promises.writeFile(r, buf);
}
function borrarMinis(id, ts) {
  fs.rmSync(rutaMini(id), { force: true });
  for (const t of ts || []) fs.rmSync(rutaMini(id, t), { force: true });
}

// ---------- video: solo con un ffmpeg que ya esté instalado ----------
let _ffmpeg; // undefined = sin buscar, null = no hay
function buscarFfmpeg() {
  if (_ffmpeg !== undefined) return _ffmpeg;
  _ffmpeg = null;
  if (process.env.BUSCAR_SIN_FFMPEG) return _ffmpeg;
  const candidatos = ['ffmpeg'];
  if (ES_WIN) candidatos.push('C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  else candidatos.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/local/bin/ffmpeg');
  for (const c of candidatos) {
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status === 0 && /ffmpeg version/.test(String(r.stdout))) { _ffmpeg = c; break; }
    } catch {}
  }
  return _ffmpeg;
}

const MAX_CUADROS = 80;
// Saca un cuadro cada N segundos a una carpeta temporal. Devuelve { dur, w, h, cuadros: [{ t, archivo }], limpiar }
async function cuadrosDeVideo(ruta) {
  const ff = buscarFfmpeg();
  if (!ff) return null;
  const sonda = await correr(ff, ['-hide_banner', '-i', ruta], { espera: 30000 });
  const md = sonda.err.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const mv = sonda.err.match(/Video: [^\n]*?[ ,](\d{2,5})x(\d{2,5})/);
  if (!mv) throw new Error('ffmpeg no encontró imagen en el video');
  const dur = md ? (+md[1]) * 3600 + (+md[2]) * 60 + (+md[3]) : 0;
  let w = +mv[1], h = +mv[2];
  const giro = sonda.err.match(/rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(\d+)/);
  if (giro && Math.abs(Math.round(+(giro[1] || giro[2]))) % 180 === 90) [w, h] = [h, w];
  const paso = Math.max(dur <= 20 ? 2 : 3, Math.ceil(dur / MAX_CUADROS));
  const dir = tmpNombre('cuadros');
  fs.mkdirSync(dir, { recursive: true });
  const limpiar = () => fs.rmSync(dir, { recursive: true, force: true });
  // el primer cuadro se toma un poco después del inicio para esquivar los fundidos desde negro
  const inicio = Math.min(1, dur / 4);
  const r = await correr(ff, ['-hide_banner', '-loglevel', 'error', '-ss', String(inicio), '-i', ruta, '-an', '-sn',
    '-vf', `fps=1/${paso},scale=${LADO_MINI}:${LADO_MINI}:force_original_aspect_ratio=decrease`, '-frames:v', String(MAX_CUADROS), '-q:v', '4', path.join(dir, 'c_%04d.jpg')], { espera: 600000 });
  const archivos = fs.readdirSync(dir).filter(n => n.endsWith('.jpg')).sort();
  if (!archivos.length) { limpiar(); throw new Error('ffmpeg no pudo leer el video' + (r.err ? ': ' + r.err.trim().split('\n').pop().slice(0, 120) : '')); }
  const cuadros = archivos.map((n, i) => ({ t: Math.round(inicio + i * paso), archivo: path.join(dir, n) }));
  return { dur, w, h, cuadros, limpiar };
}

module.exports = { colorDeMini, tipoDe, extDe, EXT_NAVEGADOR, EXT_VIDEO, procesarFoto, abrirFoto, derivar, tensorDeImagen, hashRapido, rutaMini, guardarMini, borrarMinis, buscarFfmpeg, cuadrosDeVideo, sharp, cerrar, correr, LADO_MODELO };
