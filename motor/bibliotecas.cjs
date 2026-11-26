// Registro de bibliotecas: las carpetas raíz donde vive el material. Solo guarda la ruta, nunca toca su contenido.
const path = require('path');
const fs = require('fs');
const { DATOS, HOME, leerJson, escribirJson } = require('./util.cjs');

const F = path.join(DATOS, 'bibliotecas.json');
let lista = null;
function todas() { if (!lista) lista = leerJson(F, []); return lista; }
function porId(id) { return todas().find(b => b.id === id); }

const vistas = new Map();
function conectada(b) {
  const v = vistas.get(b.id);
  if (v && Date.now() - v.t < 4000) return v.ok;
  let ok = false;
  try { ok = fs.statSync(b.ruta).isDirectory(); } catch {}
  vistas.set(b.id, { t: Date.now(), ok });
  return ok;
}

// P permite probar con las reglas de rutas de Windows (path.win32) desde cualquier sistema
function dentro(hijo, padre, P = path) {
  const rel = P.relative(padre, hijo);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel));
}

function agregar(ruta, nombre) {
  if (!ruta || !path.isAbsolute(ruta)) throw new Error('Hace falta la ruta completa de la carpeta.');
  let real;
  try { real = fs.realpathSync(ruta); } catch { throw new Error('No encuentro esa carpeta. Si está en un disco externo, conectalo primero.'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('Eso es un archivo, no una carpeta.');
  if (dentro(real, HOME) || dentro(HOME, real)) throw new Error('Esa carpeta contiene los datos del buscador. Elegí la carpeta donde está el material.');
  for (const b of todas()) {
    if (b.ruta === real) return b;
    if (dentro(real, b.ruta)) throw new Error(`Esa carpeta ya está dentro de la biblioteca "${b.nombre}".`);
    if (dentro(b.ruta, real)) throw new Error(`Esa carpeta contiene a la biblioteca "${b.nombre}". Quitá esa primero o elegí otra.`);
  }
  let n = 1;
  while (todas().some(b => b.id === 'b' + n)) n++;
  const b = { id: 'b' + n, nombre: (nombre || path.basename(real) || real).trim(), ruta: real, alta: Date.now() };
  todas().push(b);
  escribirJson(F, todas());
  return b;
}

// Apunta una biblioteca a otra ruta sin perder su índice: para cuando el disco externo cambia de letra o la carpeta se mudó.
function mover(id, ruta) {
  const b = porId(id);
  if (!b) throw new Error('No encuentro esa biblioteca.');
  let real;
  try { real = fs.realpathSync(ruta); if (!fs.statSync(real).isDirectory()) throw 0; } catch { throw new Error('No encuentro esa carpeta. Si está en un disco externo, conectalo primero.'); }
  for (const o of todas()) if (o.id !== id && (dentro(real, o.ruta) || dentro(o.ruta, real))) throw new Error(`Esa carpeta se pisa con la biblioteca "${o.nombre}".`);
  b.ruta = real; vistas.delete(id);
  escribirJson(F, todas());
  return b;
}

function quitar(id) {
  const i = todas().findIndex(b => b.id === id);
  if (i < 0) return false;
  todas().splice(i, 1);
  escribirJson(F, todas());
  return true;
}

// Ruta absoluta de un archivo indexado, comprobando que no se salga de su biblioteca.
function rutaAbsoluta(b, rel, P = path) {
  const abs = P.join(b.ruta, ...rel.split('/'));
  if (!dentro(abs, b.ruta, P) || rel.split('/').includes('..')) throw new Error('Ruta fuera de la biblioteca');
  return abs;
}

function guardar() { escribirJson(F, todas()); }

module.exports = { guardar, todas, porId, conectada, agregar, mover, quitar, rutaAbsoluta, dentro };
