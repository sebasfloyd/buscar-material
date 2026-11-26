// Etiquetas, marca de "ya usada", cliente por carpeta y lista acordada de etiquetas. Nada de esto se escribe en los
// originales ni al lado de ellos.
//
// Todo se guarda como un registro de eventos de solo agregar, dentro de una carpeta (la propia o una que el equipo
// comparte por git):
//   <carpeta>/eventos/<id de esta compu>.jsonl   una línea JSON por evento
// Cada compu escribe solamente su archivo, así que dos personas trabajando a la vez nunca le generan un conflicto a git.
// El estado se arma leyendo los archivos de todas y quedándose, para cada dato, con el evento más nuevo:
//   - cada etiqueta de cada foto es un dato aparte (dos personas que agregan etiquetas distintas a la misma foto: quedan las dos)
//   - "ya usada" es un dato por foto; cada regla de cliente, uno por carpeta; cada etiqueta de la lista acordada, uno
//   - a igual marca de tiempo gana quitar sobre agregar, y después el identificador del evento (para que todas las compus elijan lo mismo)
// La marca de tiempo nunca retrocede respecto de lo ya leído: si el reloj de esta compu atrasa, un cambio hecho acá
// igual queda después de lo que se veía en pantalla al hacerlo.
// Las fotos se identifican por huella de contenido (no por ruta) y las bibliotecas por un identificador que viaja con
// los nombres de sus subcarpetas, así que da igual en qué ruta tenga cada una el material.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const U = require('./util.cjs');
const indice = require('./indice.cjs');
const bibliotecas = require('./bibliotecas.cjs');

const POR_DEFECTO = path.join(U.HOME, 'etiquetas');
const TS_MAX = 1e14; // una marca de tiempo más allá de esto es basura, no una fecha

let cfg = null;
const leidos = new Map();    // nombre de archivo -> { firma, eventos, rotas }
let ids = new Set();         // identificadores de todos los eventos conocidos
let porHuella = new Map();   // huella -> { e: [etiquetas], u: { f, n, por } | undefined, n: nombre de referencia }
let registros = new Map();   // "biblioteca\ncarpeta" -> { lib, c, cliente | null, ts, p, id }
let conocidas = new Map();   // identificador -> { lib, nombre, carpetas: [subcarpetas de primer nivel], compu }
let lista = [];              // etiquetas acordadas por el equipo, ordenadas
let alias = new Map();       // id local de biblioteca -> identificadores que son esa misma biblioteca en otras compus
let efectivas = new Map();   // id local de biblioteca -> [{ c, cliente }] reglas que le tocan
let viejas = [];             // reglas del primer formato, atadas al nombre de la biblioteca
let personas = new Map();    // autor -> { eventos, ultimo }
let relojMax = 0;            // marca de tiempo más alta vista
let leido = 0;               // cuándo se miró la carpeta por última vez
let novedad = 0;             // cuándo llegó por última vez algo escrito por otra compu
let rotas = 0;               // líneas que no se pudieron leer
let noEsta = false;          // la carpeta compartida no aparece (se movió o el disco no está)
let firmaViejos = '';
let revision = 0;

// ---------- configuración ----------
function config() { if (!cfg) cfg = U.leerJson(U.ARCHIVO_CONFIG, {}); return cfg; }
function guardarConfig() { fs.mkdirSync(U.HOME, { recursive: true }); U.escribirJson(U.ARCHIVO_CONFIG, cfg); }
function ubicacion() { return config().etiquetas || POR_DEFECTO; }
function compartida() { return !!config().etiquetas; }
function dirEventos() { return path.join(ubicacion(), 'eventos'); }

function usuarioDelSistema() {
  try { const u = os.userInfo().username; if (u) return u; } catch {}
  return process.env.USER || process.env.USERNAME || 'alguien';
}
function limpiarAutor(t) { return String(t == null ? '' : t).normalize('NFC').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 40); }
function autor() { return limpiarAutor(config().autor) || limpiarAutor(usuarioDelSistema()) || 'alguien'; }
function fijarAutor(nombre) {
  const n = limpiarAutor(nombre);
  if (!n) throw new Error('Falta el nombre.');
  config().autor = n; guardarConfig(); revision++;
  return n;
}
// Nombre del archivo de eventos de esta compu. Se decide una vez y no cambia aunque después cambie el nombre de autor.
function compu() {
  const c = config();
  if (!c.compu) {
    const base = autor().normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'compu';
    c.compu = base + '-' + crypto.randomBytes(3).toString('hex');
    guardarConfig();
  }
  return c.compu;
}

function hoy(ms) { const d = ms ? new Date(ms) : new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } // fecha local, no UTC
function limpiar(t) { return String(t).normalize('NFC').replace(/[\s,;]+/g, ' ').trim().toLowerCase().slice(0, 40); }
function varias(x) { return Array.isArray(x) ? [...new Set(x.map(limpiar).filter(Boolean))] : []; }
const ES_FECHA = /^\d{4}-\d\d-\d\d$/;

// ---------- lectura ----------
function firmaDe(f) { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch { return ''; } }
function valido(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64
    && typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0 && e.ts < TS_MAX && typeof e.tipo === 'string';
}
// Una línea cortada (git o la sincronización escribiendo a medias), una marca de conflicto o cualquier cosa que no sea
// un evento se saltea y se cuenta. Nunca frena la lectura del resto.
function leerArchivo(f) {
  const eventos = []; let malas = 0, texto = '';
  try { texto = fs.readFileSync(f, 'utf8'); } catch { return { eventos, rotas: 0 }; }
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
  for (const l of texto.split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    let e = null;
    try { e = JSON.parse(t); } catch {}
    if (valido(e)) eventos.push(e); else malas++;
  }
  return { eventos, rotas: malas };
}
function archivosDeEventos() {
  try { return fs.readdirSync(dirEventos()).filter(n => n.endsWith('.jsonl') && !n.startsWith('.')).sort(); } catch { return []; }
}

// Mira la carpeta y vuelve a leer solo los archivos que cambiaron (por tamaño y fecha). Barato: se puede llamar seguido.
function sincronizar() {
  leido = Date.now();
  const falta = compartida() && !fs.existsSync(ubicacion());
  if (falta !== noEsta) { noEsta = falta; revision++; }
  if (noEsta) return false; // se conserva lo último que se leyó hasta que la carpeta vuelva
  let cambio = false;
  const mio = compu() + '.jsonl', actuales = archivosDeEventos();
  for (const n of actuales) {
    const f = path.join(dirEventos(), n), firma = firmaDe(f), p = leidos.get(n);
    if (p && p.firma === firma) continue;
    leidos.set(n, { firma, ...leerArchivo(f) }); cambio = true;
    if (n !== mio) novedad = Date.now();
  }
  for (const n of [...leidos.keys()]) if (!actuales.includes(n)) { leidos.delete(n); cambio = true; }
  if (cambio) reconstruir();
  if (importarViejos()) cambio = true;
  if (cambio) emparejar();
  return cambio;
}

function gana(n, a) { return !a || n.ts > a.ts || (n.ts === a.ts && (n.p > a.p || (n.p === a.p && n.id > a.id))); }

// Arma el estado desde cero con todos los eventos leídos. El resultado no depende del orden en que se lean.
function reconstruir() {
  const T = new Map(), US = new Map(), R = new Map(), K = new Map(), L = new Map(), N = new Map();
  ids = new Set(); personas = new Map(); rotas = 0;
  for (const d of leidos.values()) {
    rotas += d.rotas;
    for (const e of d.eventos) {
      if (ids.has(e.id)) continue; // el mismo evento puede estar en dos archivos (al mudar la carpeta se copian)
      ids.add(e.id);
      if (e.ts > relojMax) relojMax = e.ts;
      const por = limpiarAutor(typeof e.por === 'string' ? e.por : '');
      if (por) { const p = personas.get(por) || { eventos: 0, ultimo: 0 }; p.eventos++; if (e.ts > p.ultimo) p.ultimo = e.ts; personas.set(por, p); }
      const base = { ts: e.ts, id: e.id };
      if (e.tipo === 'etiquetas' && typeof e.h === 'string' && e.h) {
        let m = T.get(e.h); if (!m) T.set(e.h, m = new Map());
        for (const t of varias(e.mas)) { const r = { ...base, p: 0, on: true }; if (gana(r, m.get(t))) m.set(t, r); }
        for (const t of varias(e.menos)) { const r = { ...base, p: 1, on: false }; if (gana(r, m.get(t))) m.set(t, r); }
        if (typeof e.n === 'string') { const r = { ...base, p: 0, n: e.n }; if (gana(r, N.get(e.h))) N.set(e.h, r); }
      } else if (e.tipo === 'usada' && typeof e.h === 'string' && e.h) {
        const u = { f: ES_FECHA.test(e.f || '') ? e.f : hoy(e.ts) };
        if (e.nota != null && String(e.nota).trim()) u.n = String(e.nota).trim().slice(0, 200);
        const quien = limpiarAutor(typeof e.marco === 'string' ? e.marco : por); if (quien) u.por = quien;
        const r = { ...base, p: 0, u }; if (gana(r, US.get(e.h))) US.set(e.h, r);
      } else if (e.tipo === 'no-usada' && typeof e.h === 'string' && e.h) {
        const r = { ...base, p: 1, u: null }; if (gana(r, US.get(e.h))) US.set(e.h, r);
      } else if (e.tipo === 'cliente' && typeof e.lib === 'string' && e.lib) {
        const c = String(e.c || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const r = { ...base, p: e.cliente == null ? 1 : 0, lib: e.lib, c, cliente: e.cliente == null ? null : String(e.cliente).trim().slice(0, 60) };
        const k = e.lib + '\n' + c; if (gana(r, R.get(k))) R.set(k, r);
      } else if (e.tipo === 'biblioteca' && typeof e.lib === 'string' && e.lib && Array.isArray(e.carpetas)) {
        const r = { ...base, p: 0, lib: e.lib, nombre: String(e.nombre || ''), carpetas: e.carpetas.filter(x => typeof x === 'string').slice(0, 200), compu: String(e.compu || '') };
        if (gana(r, K.get(e.lib))) K.set(e.lib, r);
      } else if (e.tipo === 'lista') {
        for (const t of varias(e.mas)) { const r = { ...base, p: 0, on: true }; if (gana(r, L.get(t))) L.set(t, r); }
        for (const t of varias(e.menos)) { const r = { ...base, p: 1, on: false }; if (gana(r, L.get(t))) L.set(t, r); }
      } // un tipo que esta versión no conoce se deja pasar: lo entenderá una más nueva
    }
  }
  porHuella = new Map();
  for (const [h, m] of T) { const e = [...m].filter(([, r]) => r.on).map(([t]) => t).sort(); if (e.length) porHuella.set(h, { e, n: N.get(h) && N.get(h).n }); }
  for (const [h, r] of US) if (r.u) { const d = porHuella.get(h) || { e: [] }; d.u = r.u; porHuella.set(h, d); }
  registros = R; conocidas = K;
  lista = [...L].filter(([, r]) => r.on).map(([t]) => t).sort((a, b) => a.localeCompare(b, 'es'));
  calcularAlias();
  revision++;
}

// ---------- escritura ----------
function esperar(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
// En Windows, renombrar sobre un archivo que otro programa tiene abierto un instante (git, el antivirus) falla: se reintenta.
function reemplazar(tmp, f) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return; }
    catch (e) { if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; esperar(40 * (i + 1)); }
  }
}
function escribirSiFalta(f, texto) { try { fs.writeFileSync(f, texto, { flag: 'wx' }); } catch {} }

function tic() { relojMax = Math.max(Date.now(), relojMax + 1); return relojMax; }
function evento(tipo, datos, ts) { return { id: crypto.randomBytes(6).toString('hex'), ts: ts || tic(), por: autor(), tipo, ...datos }; }
function idFijo(...partes) { return 'v' + crypto.createHash('sha1').update(JSON.stringify(partes)).digest('hex').slice(0, 15); }

// Agrega eventos al archivo de esta compu. Se arma el archivo completo en uno temporal y se renombra, para que git
// (o quien sincronice la carpeta) nunca lo encuentre a medio escribir.
function anotar(evs) {
  if (!evs.length) return;
  if (compartida() && !fs.existsSync(ubicacion())) throw new Error(`No encuentro la carpeta compartida de etiquetas (${ubicacion()}). Si se mudó, indicá la nueva con: etiquetas compartir "<carpeta>".`);
  const dir = dirEventos(), nombre = compu() + '.jsonl', f = path.join(dir, nombre);
  fs.mkdirSync(dir, { recursive: true });
  escribirSiFalta(path.join(dir, '.gitignore'), '*.tmp\n');
  escribirSiFalta(path.join(dir, '.gitattributes'), '*.jsonl -text\n'); // que git no les cambie los finales de línea
  let previo = Buffer.alloc(0);
  try { previo = fs.readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const corte = previo.length && previo[previo.length - 1] !== 10 ? '\n' : ''; // si la última línea quedó cortada, lo nuevo no se le pega
  const agregado = Buffer.from(corte + evs.map(e => JSON.stringify(e)).join('\n') + '\n');
  const tmp = path.join(dir, `.${compu()}.${process.pid}.tmp`);
  try { fs.writeFileSync(tmp, Buffer.concat([previo, agregado])); reemplazar(tmp, f); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} fs.appendFileSync(f, agregado); }
  leidos.set(nombre, { firma: firmaDe(f), ...leerArchivo(f) });
  for (const e of evs) ids.add(e.id);
}
function aplicar(evs) { if (evs.length) { anotar(evs); reconstruir(); indice.revestir(); } }

// ---------- datos del formato anterior (etiquetas.jsonl y clientes.jsonl) ----------
// Se pasan a eventos sin tocar esos archivos. Cada dato viejo da siempre el mismo identificador de evento, así que
// importarlo otra vez (acá o en otra compu que comparte la misma carpeta) no duplica nada.
function leerLineasViejas(f) {
  let texto = '';
  try { texto = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const res = [];
  for (const l of texto.split(/\r?\n/)) { if (!l || l[0] !== '{') continue; try { res.push(JSON.parse(l)); } catch {} }
  return res;
}
function unirViejo(a, b) { // dos líneas del mismo archivo (pasaba después de una fusión de git): etiquetas de las dos, uso el más reciente
  if (!a) return b;
  const reciente = (b.m || 0) >= (a.m || 0) ? b : a, viejo = reciente === a ? b : a;
  const q = new Set(reciente.q || []);
  return { e: [...new Set([...a.e, ...b.e])].filter(x => !q.has(x)).sort(), u: reciente.u || viejo.u, n: reciente.n || viejo.n, m: Math.max(a.m || 0, b.m || 0), q: reciente.q };
}
function importarViejos() {
  const fe = path.join(ubicacion(), 'etiquetas.jsonl'), fc = path.join(ubicacion(), 'clientes.jsonl');
  const firma = firmaDe(fe) + '|' + firmaDe(fc);
  if (firma === firmaViejos) return false;
  firmaViejos = firma;
  if (firma === '|') { viejas = []; return false; }
  const evs = [], sello = m => (typeof m === 'number' && m > 0 && m < TS_MAX ? m : 1);
  const porH = new Map();
  for (const l of leerLineasViejas(fe)) if (typeof l.h === 'string' && l.h) porH.set(l.h, unirViejo(porH.get(l.h), { e: varias(l.e), u: l.u && typeof l.u === 'object' ? l.u : undefined, n: typeof l.n === 'string' ? l.n : undefined, m: l.m || 0, q: varias(l.q) }));
  for (const [h, d] of porH) {
    const ts = sello(d.m), menos = (d.q || []).filter(x => !d.e.includes(x));
    if (d.e.length || menos.length) evs.push({ id: idFijo('e', h, ts, d.e, menos), ts, por: '', tipo: 'etiquetas', h, mas: d.e, menos, n: d.n });
    if (d.u) evs.push({ id: idFijo('u', h, ts, d.u.f, d.u.n), ts, por: '', tipo: 'usada', h, f: d.u.f, nota: d.u.n, n: d.n });
  }
  viejas = [];
  for (const l of leerLineasViejas(fc)) {
    const ts = sello(l.m);
    if (l.lib && Array.isArray(l.carpetas)) evs.push({ id: idFijo('b', l.lib, ts, l.carpetas), ts, por: '', tipo: 'biblioteca', lib: String(l.lib), nombre: String(l.nombre || ''), carpetas: l.carpetas });
    else if (l.cliente == null) continue;
    else if (l.lib) evs.push({ id: idFijo('c', l.lib, l.c || '', ts, l.cliente), ts, por: '', tipo: 'cliente', lib: String(l.lib), c: l.c || '', cliente: String(l.cliente) });
    else if (l.b != null) viejas.push({ b: l.b, c: l.c || '', cliente: String(l.cliente), ts });
  }
  const nuevos = evs.filter(e => !ids.has(e.id));
  if (!nuevos.length) return false;
  try { anotar(nuevos); } catch { firmaViejos = ''; return false; } // se reintenta en la próxima lectura
  reconstruir();
  return true;
}

// ---------- reconocer la misma biblioteca en otra compu ----------
// Cada biblioteca tiene un identificador que se publica junto con los nombres de sus subcarpetas de primer nivel.
// Si dos compus registraron el mismo material antes de compartir, cada una le puso su identificador: se las reconoce
// como la misma por esas subcarpetas, y las reglas de cliente de una valen para la otra.
const cacheSub = new Map();
function subcarpetas(b) {
  const v = cacheSub.get(b.id);
  if (v && v.ruta === b.ruta && Date.now() - v.t < 30000) return v.lista;
  let l = null;
  try { l = fs.readdirSync(b.ruta, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map(e => e.name.normalize('NFC')).sort().slice(0, 200); }
  catch {} // desconectada
  cacheSub.set(b.id, { ruta: b.ruta, t: Date.now(), lista: l });
  return l;
}
function parecido(a, b) { const A = new Set(a); let comun = 0; for (const x of b) if (A.has(x)) comun++; return { comun, j: comun / (a.length + b.length - comun || 1) }; }
function esLaMisma(p) { return (p.j >= 0.5 && p.comun >= 2) || (p.j === 1 && p.comun >= 1); }

function calcularAlias() {
  const libs = bibliotecas.todas(), propias = new Set(libs.map(b => b.uid).filter(Boolean));
  alias = new Map(); efectivas = new Map();
  for (const b of libs) {
    const s = new Set(b.uid ? [b.uid] : []);
    const carpetas = subcarpetas(b) || (conocidas.get(b.uid) || {}).carpetas || [];
    if (carpetas.length) for (const k of conocidas.values()) if (!propias.has(k.lib) && esLaMisma(parecido(carpetas, k.carpetas))) s.add(k.lib);
    alias.set(b.id, s);
    const porCarpeta = new Map(); // si dos identificadores traen regla para la misma carpeta, vale la más nueva (también si es "sin regla")
    for (const r of registros.values()) if (s.has(r.lib) && gana(r, porCarpeta.get(r.c))) porCarpeta.set(r.c, r);
    efectivas.set(b.id, [...porCarpeta.values()].filter(r => r.cliente !== null).map(r => ({ c: r.c, cliente: r.cliente })));
  }
}

function emparejar() {
  const libs = bibliotecas.todas(), propias = new Set(libs.map(b => b.uid).filter(Boolean));
  const evs = []; let cambioLocal = false;
  for (const b of libs) {
    const carpetas = subcarpetas(b);
    if (!b.uid) { // biblioteca recién registrada: si ya figura en lo compartido se adopta ese identificador
      let mejor = null;
      if (carpetas && carpetas.length) for (const k of conocidas.values()) {
        if (propias.has(k.lib)) continue;
        const p = parecido(carpetas, k.carpetas);
        if (esLaMisma(p) && (!mejor || p.j > mejor.j || (p.j === mejor.j && k.lib < mejor.lib))) mejor = { lib: k.lib, j: p.j };
      }
      b.uid = mejor ? mejor.lib : 'L-' + crypto.randomBytes(4).toString('hex');
      propias.add(b.uid); cambioLocal = true;
    }
    const k = conocidas.get(b.uid);
    // se publica si nadie la publicó; se actualiza solo si la publicó esta compu (si no, dos compus con carpetas distintas se corregirían una a la otra sin fin)
    if (carpetas && (!k || (k.compu === compu() && carpetas.length && parecido(carpetas, k.carpetas).j < 0.8))) evs.push(evento('biblioteca', { lib: b.uid, nombre: b.nombre, carpetas, compu: compu() }));
    for (const v of viejas.filter(x => x.b === b.nombre)) { // reglas del primer formato (por nombre de biblioteca): pasan al identificador
      const e = { id: idFijo('c', b.uid, v.c, v.ts, v.cliente), ts: v.ts, por: '', tipo: 'cliente', lib: b.uid, c: v.c, cliente: v.cliente };
      if (!ids.has(e.id)) evs.push(e);
    }
  }
  if (cambioLocal) bibliotecas.guardar();
  let hecho = false;
  if (evs.length) { try { anotar(evs); reconstruir(); hecho = true; } catch {} }
  if (!hecho) calcularAlias();
}

// ---------- lo que el índice necesita de cada archivo ----------
function clienteDe(r) {
  const i = r.rel.lastIndexOf('/');
  const dir = i < 0 ? '' : r.rel.slice(0, i).normalize('NFC');
  let mejor = null;
  for (const g of efectivas.get(r.lib) || []) {
    const c = g.c.normalize('NFC');
    if (c === '' || dir === c || dir.startsWith(c + '/')) if (!mejor || c.length > mejor.c.length) mejor = g; // gana la regla más específica
  }
  if (mejor) return mejor.cliente;
  return i < 0 ? '' : r.rel.split('/')[0]; // sin regla: la primera subcarpeta, como sugerencia inicial
}
// Una foto que esta compu todavía no indexó puede tener etiquetas puestas por otra: quedan guardadas por huella y
// aparecen solas cuando se indexe.
function decorar(r) {
  const d = r.hr ? porHuella.get(r.hr) : null;
  return { cliente: clienteDe(r), etiquetas: d && d.e ? d.e : [], usada: d && d.u ? d.u : null };
}

// ---------- cambios ----------
function etiquetar(idsArchivos, agregar = [], quitar = []) {
  refrescar();
  const mas = varias(agregar), menos = varias(quitar).filter(x => !mas.includes(x));
  const evs = [], hechas = new Set(), ts = tic();
  let n = 0;
  for (const id of idsArchivos) {
    const r = indice.archivos.get(Number(id));
    if (!r || !r.hr) continue;
    n++;
    if (hechas.has(r.hr)) continue; // dos copias idénticas comparten huella: un solo evento
    hechas.add(r.hr);
    const tiene = (porHuella.get(r.hr) || { e: [] }).e;
    const a = mas.filter(x => !tiene.includes(x)), q = menos.filter(x => tiene.includes(x));
    if (a.length || q.length) evs.push(evento('etiquetas', { h: r.hr, ...(a.length ? { mas: a } : {}), ...(q.length ? { menos: q } : {}), n: r._nombre }, ts));
  }
  aplicar(evs);
  return n;
}
function marcarUso(idsArchivos, usada, nota, fecha) {
  refrescar();
  const evs = [], hechas = new Set(), ts = tic();
  let n = 0;
  for (const id of idsArchivos) {
    const r = indice.archivos.get(Number(id));
    if (!r || !r.hr) continue;
    n++;
    if (hechas.has(r.hr)) continue;
    hechas.add(r.hr);
    const u = (porHuella.get(r.hr) || {}).u;
    if (usada) {
      const d = { h: r.hr, f: fecha || (u && u.f) || hoy() };
      const t = nota != null ? String(nota).trim().slice(0, 200) : (u && u.n);
      if (t) d.nota = t;
      if (u && u.f === d.f && (u.n || '') === (d.nota || '')) continue; // ya estaba igual
      if (u && u.por) d.marco = u.por; // cambiar la nota no cambia quién la marcó
      d.n = r._nombre;
      evs.push(evento('usada', d, ts));
    } else if (u) evs.push(evento('no-usada', { h: r.hr, n: r._nombre }, ts));
  }
  aplicar(evs);
  return n;
}
function fijarCliente(idBiblioteca, carpetaRel, cliente) {
  refrescar(); emparejar();
  const b = bibliotecas.porId(idBiblioteca);
  if (!b || !b.uid) throw new Error('No encuentro esa biblioteca.');
  const c = String(carpetaRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  aplicar([evento('cliente', { lib: b.uid, c, cliente: cliente == null ? null : String(cliente).trim().slice(0, 60) })]);
}
// Renombrar a un nombre que ya existe los une. Los clientes detectados por carpeta se convierten en regla al renombrarlos.
function renombrarCliente(de, a) {
  refrescar();
  a = String(a).trim().slice(0, 60);
  const vistas = new Set();
  for (const r of indice.archivos.values()) {
    if (r._cliente !== de) continue;
    const b = bibliotecas.porId(r.lib); if (!b || !b.uid) continue;
    const dir = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '';
    const regla = (efectivas.get(b.id) || []).filter(g => g.c === '' || dir === g.c || dir.startsWith(g.c + '/')).sort((x, y) => y.c.length - x.c.length)[0];
    vistas.add(b.uid + '\n' + (regla ? regla.c : r.rel.split('/')[0]));
  }
  const ts = tic();
  aplicar([...vistas].map(k => { const [lib, c] = k.split('\n'); return evento('cliente', { lib, c, cliente: a }, ts); }));
  return vistas.size;
}
// Lista acordada de etiquetas del equipo. No prohíbe nada: sirve para sugerir y para distinguir las "de la lista" de las sueltas.
function cambiarLista(agregar = [], quitar = []) {
  refrescar();
  const mas = varias(agregar).filter(x => !lista.includes(x)), menos = varias(quitar).filter(x => lista.includes(x) && !varias(agregar).includes(x));
  if (mas.length || menos.length) aplicar([evento('lista', { ...(mas.length ? { mas } : {}), ...(menos.length ? { menos } : {}) })]);
  return { lista, agregadas: mas, quitadas: menos };
}

// Cambia dónde se guardan (null: de vuelta solo en esta compu). Todo lo que había en el lugar anterior se lleva al
// nuevo, y lo que ya había en el nuevo se conserva: no se pierde nada de ninguno de los dos.
function mudar(nueva) {
  let destino = null;
  if (nueva) {
    if (!path.isAbsolute(nueva)) throw new Error('Hace falta la ruta completa de la carpeta.');
    destino = path.resolve(nueva);
    for (const b of bibliotecas.todas()) if (bibliotecas.dentro(destino, b.ruta)) throw new Error('Esa carpeta está dentro de una biblioteca de material. Elegí otra: junto a los originales no se escribe nada.');
  }
  sincronizar();
  const llevar = []; const vistos = new Set();
  for (const d of leidos.values()) for (const e of d.eventos) if (!vistos.has(e.id)) { vistos.add(e.id); llevar.push(e); }
  if (destino) fs.mkdirSync(destino, { recursive: true });
  if (destino && destino !== POR_DEFECTO) config().etiquetas = destino; else delete config().etiquetas;
  guardarConfig();
  leidos.clear(); firmaViejos = ''; novedad = 0; noEsta = false; viejas = [];
  reconstruir();
  sincronizar(); // lee lo que ya había en el lugar nuevo (y pasa al formato actual lo que esté en el anterior)
  anotar(llevar.filter(e => !ids.has(e.id)));
  reconstruir(); emparejar(); indice.revestir();
  return ubicacion();
}

let cuentaCache = { clave: '', valor: null };
function resumen() {
  const clave = indice.version + ':' + revision;
  if (cuentaCache.clave !== clave) {
    const cuenta = new Map(), presentes = new Set(); let usadas = 0;
    for (const r of indice.archivos.values()) { for (const e of r._etiquetas) cuenta.set(e, (cuenta.get(e) || 0) + 1); if (r._usada) usadas++; if (r.hr) presentes.add(r.hr); }
    let sinIndexar = 0; for (const h of porHuella.keys()) if (!presentes.has(h)) sinIndexar++;
    const enLista = new Set(lista);
    const reglas = [];
    for (const b of bibliotecas.todas()) for (const g of efectivas.get(b.id) || []) reglas.push({ lib: b.uid, c: g.c, cliente: g.cliente });
    cuentaCache = { clave, valor: {
      etiquetas: [...cuenta].map(([nombre, n]) => ({ nombre, n, lista: enLista.has(nombre) })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      usadas, reglas, lista, sinIndexar,
    } };
  }
  return {
    ...cuentaCache.valor, carpeta: ubicacion(),
    compartida: {
      activa: compartida(), carpeta: ubicacion(), autor: autor(), archivo: 'eventos/' + compu() + '.jsonl',
      leido, novedad, falta: noEsta, eventos: ids.size, lineasRotas: rotas, archivos: leidos.size,
      personas: [...personas].map(([nombre, p]) => ({ nombre, eventos: p.eventos, ultimo: p.ultimo })).sort((a, b) => b.ultimo - a.ultimo),
    },
  };
}

function iniciar() { indice.alDecorar(decorar); sincronizar(); reconstruir(); emparejar(); }
// minimo: si hace menos de esos milisegundos que se miró la carpeta, no se vuelve a mirar (para llamarlo en cada búsqueda)
function refrescar(minimo = 0) {
  if (minimo && Date.now() - leido < minimo) return false;
  if (sincronizar()) { indice.revestir(); return true; }
  return false;
}

module.exports = { emparejar() { emparejar(); indice.revestir(); }, iniciar, refrescar, etiquetar, marcarUso, fijarCliente, renombrarCliente, cambiarLista, fijarAutor, mudar, resumen, ubicacion, limpiar };
