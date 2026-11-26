// Índice en memoria con persistencia simple: vectores en binario plano y una línea JSON por archivo.
// No usa ninguna base de datos. Búsqueda por fuerza bruta sobre un Float32Array.
const path = require('path');
const fs = require('fs');
const { DATOS, normalizar } = require('./util.cjs');
const { DIM } = require('./modelo.cjs');

const F_ARCHIVOS = path.join(DATOS, 'archivos.jsonl');
const F_VECTORES = path.join(DATOS, 'vectores.bin');
const BYTES = DIM * 4;

const archivos = new Map();   // id -> registro
const porClave = new Map();   // "lib|ruta relativa" -> id
let vectores = new Float32Array(DIM * 1024);
let filas = 0;       // filas escritas en vectores.bin (vivas o no)
let filasVivas = 0;
let proximoId = 1;
let version = 1;     // cambia con cada modificación: invalida cachés de búsqueda

// La clave se normaliza (NFC) para que "ñ" compuesta y descompuesta sean el mismo archivo; la ruta se guarda tal cual está en el disco.
function clave(lib, rel) { return lib + '|' + rel.normalize('NFC'); }

// Campos derivados que no se guardan en disco. El cliente y las etiquetas los aporta etiquetas.cjs a través de "decorar".
let decorar = null; // (registro) => { cliente, etiquetas: [], usada: {f, n} | null }
function oculto(r, k, v) { Object.defineProperty(r, k, { value: v, enumerable: false, writable: true, configurable: true }); }
function vestir(r) {
  const partes = r.rel.split('/');
  const extra = decorar ? decorar(r) : { cliente: partes.length > 1 ? partes[0] : '', etiquetas: [], usada: null };
  oculto(r, '_cliente', extra.cliente);
  oculto(r, '_etiquetas', extra.etiquetas);
  oculto(r, '_usada', extra.usada);
  oculto(r, '_nombre', partes[partes.length - 1]);
  oculto(r, '_texto', ' ' + normalizar(r.rel + ' ' + extra.cliente + ' ' + extra.etiquetas.join(' ')) + ' ');
  let o = '';
  if (r.w && r.h) { const p = r.w / r.h; o = p > 1.08 ? 'h' : p < 0.92 ? 'v' : 'c'; }
  oculto(r, '_orient', o);
  return r;
}
// Vuelve a calcular cliente y etiquetas de todo (cuando cambian las reglas o el archivo de etiquetas)
function revestir(soloIds) {
  if (soloIds) for (const id of soloIds) { const r = archivos.get(id); if (r) vestir(r); }
  else for (const r of archivos.values()) vestir(r);
  version++;
}

function crecer(n) {
  if (n * DIM <= vectores.length) return;
  let cap = vectores.length;
  while (cap < n * DIM) cap *= 2;
  const nuevo = new Float32Array(cap);
  nuevo.set(vectores.subarray(0, filas * DIM));
  vectores = nuevo;
}

function cargar() {
  archivos.clear(); porClave.clear(); filas = 0; filasVivas = 0; proximoId = 1;
  let disponibles = 0, lineas = 0;
  if (fs.existsSync(F_VECTORES)) {
    const buf = fs.readFileSync(F_VECTORES);
    disponibles = Math.floor(buf.length / BYTES);
    crecer(disponibles + 256);
    vectores.set(new Float32Array(buf.buffer, buf.byteOffset, disponibles * DIM));
    filas = disponibles;
    if (buf.length !== disponibles * BYTES) fs.truncateSync(F_VECTORES, disponibles * BYTES); // quedó una escritura a medias
  }
  if (fs.existsSync(F_ARCHIVOS)) {
    for (const linea of fs.readFileSync(F_ARCHIVOS, 'utf8').split('\n')) {
      if (!linea) continue;
      lineas++;
      let r; try { r = JSON.parse(linea); } catch { continue; } // última línea cortada: se ignora
      if (r.id >= proximoId) proximoId = r.id + 1;
      const previo = archivos.get(r.id);
      if (previo) { porClave.delete(clave(previo.lib, previo.rel)); archivos.delete(r.id); }
      if (r.borrado) continue;
      if (r.vn && r.v0 + r.vn > disponibles) continue; // el registro apunta a vectores que no llegaron al disco
      archivos.set(r.id, vestir(r));
      porClave.set(clave(r.lib, r.rel), r.id);
    }
  }
  for (const r of archivos.values()) filasVivas += r.vn || 0;
  if ((filas > 512 && filasVivas < filas * 0.7) || lineas > archivos.size * 1.6 + 200) compactar(); // huecos de vectores o demasiadas líneas repetidas
  version++;
}

function nuevoId() { return proximoId++; }

// Agrega o reemplaza un archivo. vecs: lista de Float32Array (una por foto, una por cuadro de video; puede ser vacía).
function guardar(reg, vecs) {
  const previo = archivos.get(reg.id);
  if (previo) { filasVivas -= previo.vn || 0; porClave.delete(clave(previo.lib, previo.rel)); }
  reg.v0 = filas; reg.vn = vecs.length;
  if (vecs.length) {
    crecer(filas + vecs.length);
    const bloque = Buffer.allocUnsafe(vecs.length * BYTES);
    vecs.forEach((v, i) => {
      vectores.set(v, (filas + i) * DIM);
      Buffer.from(v.buffer, v.byteOffset, BYTES).copy(bloque, i * BYTES);
    });
    fs.appendFileSync(F_VECTORES, bloque); // primero los vectores, después el registro que los nombra
    filas += vecs.length; filasVivas += vecs.length;
  }
  fs.appendFileSync(F_ARCHIVOS, JSON.stringify(reg) + '\n');
  archivos.set(reg.id, vestir(reg));
  porClave.set(clave(reg.lib, reg.rel), reg.id);
  version++;
}

// Vuelve a anotar un registro que cambió algún dato suelto, sin tocar sus vectores
function reescribir(r) {
  fs.appendFileSync(F_ARCHIVOS, JSON.stringify(r) + '\n');
  vestir(r); version++;
}

function borrar(id) {
  const r = archivos.get(id);
  if (!r) return;
  filasVivas -= r.vn || 0;
  archivos.delete(id); porClave.delete(clave(r.lib, r.rel));
  fs.appendFileSync(F_ARCHIVOS, JSON.stringify({ id, borrado: 1 }) + '\n');
  version++;
}

// Reescribe los dos archivos sin los huecos que dejan las fotos borradas o modificadas.
function compactar() {
  const lista = [...archivos.values()].sort((a, b) => a.v0 - b.v0);
  const nuevo = new Float32Array(Math.max(DIM * 1024, vectores.length));
  let n = 0;
  for (const r of lista) {
    if (r.vn) nuevo.set(vectores.subarray(r.v0 * DIM, (r.v0 + r.vn) * DIM), n * DIM);
    r.v0 = n; n += r.vn || 0;
  }
  vectores = nuevo; filas = n; filasVivas = n;
  const tv = F_VECTORES + '.tmp', ta = F_ARCHIVOS + '.tmp';
  fs.writeFileSync(tv, Buffer.from(vectores.buffer, 0, n * BYTES));
  fs.writeFileSync(ta, lista.map(r => JSON.stringify(r)).join('\n') + (lista.length ? '\n' : ''));
  fs.renameSync(ta, F_ARCHIVOS); fs.renameSync(tv, F_VECTORES);
  version++;
}

function compactarSiConviene() { if (filas > 512 && filasVivas < filas * 0.8) compactar(); }

function vectorDeFila(f) { return vectores.subarray(f * DIM, (f + 1) * DIM); }

// Mejor parecido entre la consulta y las filas de un archivo. Devuelve [puntaje, índice del cuadro].
function parecido(r, q) {
  let mejor = -2, cual = 0;
  const V = vectores;
  for (let k = 0; k < r.vn; k++) {
    let o = (r.v0 + k) * DIM, s = 0;
    for (let i = 0; i < DIM; i += 4) s += V[o + i] * q[i] + V[o + i + 1] * q[i + 1] + V[o + i + 2] * q[i + 2] + V[o + i + 3] * q[i + 3];
    if (s > mejor) { mejor = s; cual = k; }
  }
  return [mejor, cual];
}

function tamanoEnDisco() {
  let t = 0;
  for (const f of [F_ARCHIVOS, F_VECTORES]) try { t += fs.statSync(f).size; } catch {}
  return t;
}

module.exports = {
  reescribir, revestir, alDecorar(f) { decorar = f; }, tocar() { version++; },
  archivos, porClave, clave, cargar, guardar, borrar, nuevoId, compactar, compactarSiConviene, vectorDeFila, parecido, tamanoEnDisco,
  get version() { return version; }, get filas() { return filasVivas; },
};
