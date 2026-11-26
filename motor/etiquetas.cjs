// Etiquetas, marca de "ya usada" y cliente por carpeta. Nada de esto se escribe en los originales ni al lado de ellos.
// Viven en dos archivos de texto, una línea por dato y en orden estable, pensados para compartirse por git:
//   etiquetas.jsonl  una línea por archivo, identificado por huella de contenido (no por ruta)
//   clientes.jsonl   una línea por biblioteca conocida (un identificador y sus subcarpetas, para reconocerla en otra compu
//                    aunque se llame distinto) y una línea por regla "esta carpeta es de tal cliente"
const path = require('path');
const fs = require('fs');
const U = require('./util.cjs');
const indice = require('./indice.cjs');
const bibliotecas = require('./bibliotecas.cjs');

const POR_DEFECTO = path.join(U.HOME, 'etiquetas');
let carpeta = null;
let porHuella = new Map();   // huella -> { e: [etiquetas], u: { f, n } | undefined, n: nombre de referencia, m: última modificación }
let reglas = [];             // { lib: identificador compartido de la biblioteca, c: carpeta relativa ('' = toda), cliente }
let conocidas = new Map();   // identificador -> { lib, nombre, carpetas: [subcarpetas de primer nivel], m }
let viejas = [];             // reglas de la versión anterior, atadas al nombre de la biblioteca: se convierten al emparejar
let visto = { e: 0, c: 0 };  // fecha de modificación con que se leyó cada archivo

function ubicacion() {
  if (!carpeta) carpeta = U.leerJson(U.ARCHIVO_CONFIG, {}).etiquetas || POR_DEFECTO;
  return carpeta;
}
const fEtiquetas = () => path.join(ubicacion(), 'etiquetas.jsonl');
const fClientes = () => path.join(ubicacion(), 'clientes.jsonl');
function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

function hoy() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } // fecha local, no UTC
function limpiar(t) { return String(t).normalize('NFC').replace(/[\s,;]+/g, ' ').trim().toLowerCase().slice(0, 40); }

// Si dos líneas hablan del mismo archivo (pasa después de una fusión de git), se unen: etiquetas de las dos, uso el más reciente.
function unir(a, b) {
  if (!a) return b;
  const reciente = (b.m || 0) >= (a.m || 0) ? b : a, viejo = reciente === a ? b : a;
  const q = new Set(reciente.q || []);
  const e = [...new Set([...(a.e || []), ...(b.e || [])])].filter(x => !q.has(x)).sort();
  return { e, u: reciente.u !== undefined ? reciente.u : viejo.u, n: reciente.n || viejo.n, m: Math.max(a.m || 0, b.m || 0), q: reciente.q };
}

function leerLineas(f) {
  let texto = '';
  try { texto = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const res = [];
  for (const l of texto.split(/\r?\n/)) { if (!l || l[0] !== '{') continue; try { res.push(JSON.parse(l)); } catch {} } // marcas de conflicto y líneas rotas se ignoran
  return res;
}

function cargar() {
  porHuella = new Map();
  for (const l of leerLineas(fEtiquetas())) if (l.h) porHuella.set(l.h, unir(porHuella.get(l.h), { e: (l.e || []).map(limpiar).filter(Boolean), u: l.u === undefined ? undefined : l.u, n: l.n, m: l.m || 0, q: l.q }));
  const r = new Map(); conocidas = new Map(); viejas = [];
  for (const l of leerLineas(fClientes())) {
    if (l.lib && l.carpetas) { const p = conocidas.get(l.lib); if (!p || (l.m || 0) >= (p.m || 0)) conocidas.set(l.lib, { lib: l.lib, nombre: l.nombre || '', carpetas: l.carpetas, m: l.m || 0 }); continue; }
    if (l.cliente == null) continue;
    if (l.lib) { const k = l.lib + '\n' + (l.c || ''); const p = r.get(k); if (!p || (l.m || 0) >= (p.m || 0)) r.set(k, { lib: l.lib, c: l.c || '', cliente: String(l.cliente).trim(), m: l.m || 0 }); }
    else if (l.b != null) viejas.push({ b: l.b, c: l.c || '', cliente: String(l.cliente).trim(), m: l.m || 0 });
  }
  reglas = [...r.values()];
  emparejar();
  visto = { e: mtime(fEtiquetas()), c: mtime(fClientes()) };
}

// Si alguien más cambió los archivos (por ejemplo al bajar cambios de git), se vuelven a leer.
function refrescar() {
  if (mtime(fEtiquetas()) !== visto.e || mtime(fClientes()) !== visto.c) { cargar(); indice.revestir(); return true; }
  return false;
}

function escribir(f, lineas) {
  fs.mkdirSync(ubicacion(), { recursive: true });
  const atributos = path.join(ubicacion(), '.gitattributes');
  // "union" le dice a git que, si dos personas agregan líneas en el mismo lugar, se quede con las de las dos en vez de marcar conflicto
  if (!fs.existsSync(atributos)) fs.writeFileSync(atributos, 'etiquetas.jsonl merge=union\nclientes.jsonl merge=union\n');
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, lineas.join('\n') + (lineas.length ? '\n' : ''));
  fs.renameSync(tmp, f);
}
function guardarEtiquetas() {
  const lineas = [...porHuella.entries()].filter(([, d]) => (d.e && d.e.length) || d.u || (d.q && d.q.length)).sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([h, d]) => { const o = { h, e: d.e || [] }; if (d.u) o.u = d.u; if (d.q && d.q.length) o.q = d.q; if (d.n) o.n = d.n; o.m = d.m; return JSON.stringify(o); });
  escribir(fEtiquetas(), lineas);
  visto.e = mtime(fEtiquetas());
}
function guardarClientes() {
  const lineas = [...conocidas.values()].sort((a, b) => a.lib < b.lib ? -1 : 1).map(k => JSON.stringify({ lib: k.lib, nombre: k.nombre, carpetas: k.carpetas, m: k.m }))
    .concat(reglas.slice().sort((a, b) => (a.lib + '\n' + a.c) < (b.lib + '\n' + b.c) ? -1 : 1).map(r => JSON.stringify({ lib: r.lib, c: r.c, cliente: r.cliente, m: r.m })))
    .concat(viejas.map(r => JSON.stringify(r))); // las que todavía no encontraron su biblioteca en esta compu se conservan
  escribir(fClientes(), lineas);
  visto.c = mtime(fClientes());
}

// ---------- reconocer la misma biblioteca en otra compu ----------
// Cada biblioteca tiene un identificador que viaja en clientes.jsonl junto con los nombres de sus subcarpetas de primer nivel.
// Al registrar una carpeta en otra compu (con otro nombre, otra ruta u otra letra de disco) se la reconoce por esas subcarpetas.
function subcarpetas(b) {
  try { return fs.readdirSync(b.ruta, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map(e => e.name.normalize('NFC')).sort().slice(0, 200); }
  catch { return null; } // desconectada
}
function parecido(a, b) { const A = new Set(a); let comun = 0; for (const x of b) if (A.has(x)) comun++; return { comun, j: comun / (a.length + b.length - comun || 1) }; }
function emparejar() {
  let cambioLocal = false, cambioCompartido = false;
  const tomadas = new Set(bibliotecas.todas().filter(b => b.uid && conocidas.has(b.uid)).map(b => b.uid));
  for (const b of bibliotecas.todas()) {
    const carpetas = subcarpetas(b);
    if (!b.uid || !conocidas.has(b.uid)) {
      let mejor = null;
      if (!b.uid && carpetas && carpetas.length) for (const k of conocidas.values()) {
        if (tomadas.has(k.lib)) continue;
        const p = parecido(carpetas, k.carpetas);
        if ((p.j >= 0.5 && p.comun >= 2) || (p.j === 1 && p.comun >= 1)) if (!mejor || p.j > mejor.j) mejor = { lib: k.lib, j: p.j };
      }
      if (mejor) { b.uid = mejor.lib; tomadas.add(b.uid); cambioLocal = true; }
      else {
        if (!b.uid) { b.uid = 'L-' + require('crypto').randomBytes(4).toString('hex'); cambioLocal = true; }
        if (carpetas) { conocidas.set(b.uid, { lib: b.uid, nombre: b.nombre, carpetas, m: Date.now() }); tomadas.add(b.uid); cambioCompartido = true; }
      }
    } else if (carpetas && carpetas.length && parecido(carpetas, conocidas.get(b.uid).carpetas).j < 0.8) { // aparecieron o se fueron carpetas: se actualiza la huella
      conocidas.set(b.uid, { ...conocidas.get(b.uid), carpetas, m: Date.now() }); cambioCompartido = true;
    }
    // reglas de la versión anterior (por nombre de biblioteca): pasan al identificador
    const mias = viejas.filter(v => v.b === b.nombre);
    if (mias.length && b.uid) {
      for (const v of mias) if (!reglas.some(g => g.lib === b.uid && g.c === v.c)) reglas.push({ lib: b.uid, c: v.c, cliente: v.cliente, m: v.m });
      viejas = viejas.filter(v => v.b !== b.nombre); cambioCompartido = true;
    }
  }
  if (cambioLocal) bibliotecas.guardar();
  if (cambioCompartido) { try { guardarClientes(); } catch {} }
  return cambioLocal || cambioCompartido;
}

// ---------- lo que el índice necesita de cada archivo ----------
function clienteDe(r) {
  const b = bibliotecas.porId(r.lib);
  const i = r.rel.lastIndexOf('/');
  const dir = i < 0 ? '' : r.rel.slice(0, i).normalize('NFC');
  let mejor = null;
  if (b && b.uid) for (const g of reglas) {
    if (g.lib !== b.uid) continue;
    const c = g.c.normalize('NFC');
    if (c === '' || dir === c || dir.startsWith(c + '/')) if (!mejor || c.length > mejor.c.length) mejor = g; // gana la regla más específica
  }
  if (mejor) return mejor.cliente;
  return i < 0 ? '' : r.rel.split('/')[0]; // sin regla: la primera subcarpeta, como sugerencia inicial
}
function decorar(r) {
  const d = r.hr ? porHuella.get(r.hr) : null;
  return { cliente: clienteDe(r), etiquetas: d && d.e ? d.e : [], usada: d && d.u ? d.u : null };
}

// ---------- cambios ----------
function etiquetar(ids, agregar = [], quitar = []) {
  refrescar();
  const mas = agregar.map(limpiar).filter(Boolean), menos = new Set(quitar.map(limpiar));
  let n = 0;
  for (const id of ids) {
    const r = indice.archivos.get(Number(id));
    if (!r || !r.hr) continue;
    const d = porHuella.get(r.hr) || { e: [] };
    const q = new Set((d.q || []).filter(x => !mas.includes(x)));
    for (const x of menos) if ((d.e || []).includes(x)) q.add(x); // se anota lo quitado para que una fusión no lo reviva
    d.e = [...new Set([...(d.e || []), ...mas])].filter(x => !menos.has(x)).sort();
    d.q = [...q].sort(); d.n = r._nombre; d.m = Date.now();
    porHuella.set(r.hr, d); n++;
  }
  guardarEtiquetas(); indice.revestir();
  return n;
}
function marcarUso(ids, usada, nota, fecha) {
  refrescar();
  let n = 0;
  for (const id of ids) {
    const r = indice.archivos.get(Number(id));
    if (!r || !r.hr) continue;
    const d = porHuella.get(r.hr) || { e: [] };
    if (usada) { const u = { f: fecha || (d.u && d.u.f) || hoy() }; const t = nota != null ? String(nota).trim().slice(0, 200) : (d.u && d.u.n); if (t) u.n = t; d.u = u; }
    else d.u = null;
    d.n = r._nombre; d.m = Date.now();
    porHuella.set(r.hr, d); n++;
  }
  guardarEtiquetas(); indice.revestir();
  return n;
}
function fijarCliente(idBiblioteca, carpetaRel, cliente) {
  refrescar(); emparejar();
  const b = bibliotecas.porId(idBiblioteca);
  if (!b || !b.uid) throw new Error('No encuentro esa biblioteca.');
  const c = String(carpetaRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  reglas = reglas.filter(g => !(g.lib === b.uid && g.c === c));
  if (cliente != null) reglas.push({ lib: b.uid, c, cliente: String(cliente).trim().slice(0, 60), m: Date.now() });
  guardarClientes(); indice.revestir();
}
// Renombrar a un nombre que ya existe los une. Los clientes detectados por carpeta se convierten en regla al renombrarlos.
function renombrarCliente(de, a) {
  refrescar();
  a = String(a).trim().slice(0, 60);
  const vistas = new Set();
  for (const r of indice.archivos.values()) {
    if (r._cliente !== de) continue;
    const b = bibliotecas.porId(r.lib); if (!b) continue;
    const dir = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '';
    if (!b.uid) continue;
    const regla = reglas.filter(g => g.lib === b.uid && (g.c === '' || dir === g.c || dir.startsWith(g.c + '/'))).sort((x, y) => y.c.length - x.c.length)[0];
    const c = regla ? regla.c : r.rel.split('/')[0];
    vistas.add(b.uid + '\n' + c);
  }
  for (const k of vistas) { const [lib, c] = k.split('\n'); reglas = reglas.filter(g => !(g.lib === lib && g.c === c)); reglas.push({ lib, c, cliente: a, m: Date.now() }); }
  guardarClientes(); indice.revestir();
  return vistas.size;
}

// Cambia dónde se guardan. Lo que ya había en el lugar nuevo se une con lo de acá: no se pierde nada de ninguno de los dos.
function mudar(nueva) {
  if (!nueva || !path.isAbsolute(nueva)) throw new Error('Hace falta la ruta completa de la carpeta.');
  for (const b of bibliotecas.todas()) if (bibliotecas.dentro(path.resolve(nueva), b.ruta)) throw new Error('Esa carpeta está dentro de una biblioteca de material. Elegí otra: junto a los originales no se escribe nada.');
  refrescar();
  const mias = porHuella, misReglas = reglas, misConocidas = conocidas, misViejas = viejas;
  fs.mkdirSync(nueva, { recursive: true });
  const cfg = U.leerJson(U.ARCHIVO_CONFIG, {}); cfg.etiquetas = path.resolve(nueva); U.escribirJson(U.ARCHIVO_CONFIG, cfg);
  carpeta = cfg.etiquetas;
  cargar();
  for (const [h, d] of mias) porHuella.set(h, unir(porHuella.get(h), d));
  // si en el lugar nuevo ya figura esta misma biblioteca con otro identificador, se adopta el de allá y las reglas propias lo siguen
  const cambio = new Map();
  for (const b of bibliotecas.todas()) { const antes = b.uid; if (antes && !conocidas.has(antes)) { b.uid = undefined; emparejar(); if (b.uid !== antes) cambio.set(antes, b.uid); } }
  for (const g of misReglas) { const lib = cambio.get(g.lib) || g.lib; if (!reglas.some(x => x.lib === lib && x.c === g.c)) reglas.push({ ...g, lib }); }
  for (const [k, v] of misConocidas) if (!conocidas.has(k) && !cambio.has(k)) conocidas.set(k, v);
  for (const v of misViejas) if (!viejas.some(x => x.b === v.b && x.c === v.c)) viejas.push(v);
  bibliotecas.guardar();
  guardarEtiquetas(); guardarClientes(); indice.revestir();
  return carpeta;
}

function resumen() {
  const cuenta = new Map(); let usadas = 0;
  for (const r of indice.archivos.values()) { for (const e of r._etiquetas) cuenta.set(e, (cuenta.get(e) || 0) + 1); if (r._usada) usadas++; }
  return { etiquetas: [...cuenta].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')), usadas, reglas: reglas.map(g => ({ lib: g.lib, c: g.c, cliente: g.cliente })), carpeta: ubicacion() };
}

function iniciar() { cargar(); indice.alDecorar(decorar); }

module.exports = { emparejar() { if (emparejar()) indice.revestir(); }, iniciar, refrescar, etiquetar, marcarUso, fijarCliente, renombrarCliente, mudar, resumen, ubicacion, limpiar };
