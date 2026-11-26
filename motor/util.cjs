// Rutas, dependencias y utilidades compartidas. No toca nada fuera de la carpeta de datos.
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = process.env.BUSCAR_MATERIAL_HOME || path.join(os.homedir(), '.mente-ai', 'buscar-material');
const DATOS = path.join(HOME, 'datos');
const MINIATURAS = path.join(HOME, 'miniaturas');
const MODELOS = path.join(HOME, 'modelos');
const TMP = path.join(HOME, 'tmp');
const ARCHIVO_SERVIDOR = path.join(HOME, 'servidor.json');
const PUERTO = Number(process.env.BUSCAR_PUERTO) || 4517;
const ARCHIVO_CONFIG = path.join(HOME, 'config.json');
const ES_WIN = process.platform === 'win32';
const ES_MAC = process.platform === 'darwin';

let _req = null;
// Las dependencias viven en HOME/node_modules: se cargan desde ahí, no desde la carpeta de la skill.
function dep(nombre) {
  if (!_req) _req = require('module').createRequire(path.join(HOME, 'package.json'));
  return _req(nombre);
}

function asegurarCarpetas() {
  for (const d of [HOME, DATOS, MINIATURAS, MODELOS, TMP]) fs.mkdirSync(d, { recursive: true });
}

function leerJson(ruta, defecto) {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return defecto; }
}

function escribirJson(ruta, dato) {
  const tmp = ruta + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(dato, null, 1));
  fs.renameSync(tmp, ruta);
}

// minúsculas, sin acentos, separadores como espacios: para comparar nombres y carpetas
function normalizar(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'sin', 'en', 'sobre', 'y', 'o', 'a', 'al', 'para', 'por', 'que', 'se', 'su', 'the', 'of']);
function palabrasClave(q) {
  return normalizar(q).split(' ').filter(p => p.length >= 2 && !VACIAS.has(p));
}

function ahora() { return Date.now(); }

module.exports = { ARCHIVO_CONFIG, HOME, DATOS, MINIATURAS, MODELOS, TMP, ARCHIVO_SERVIDOR, PUERTO, ES_WIN, ES_MAC, dep, asegurarCarpetas, leerJson, escribirJson, normalizar, palabrasClave, ahora };
