// Servidor local del buscador. Escucha solo en 127.0.0.1 y se cierra solo tras un rato sin uso.
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const U = require('./util.cjs');
const indice = require('./indice.cjs');
const medios = require('./medios.cjs');
const modelo = require('./modelo.cjs');
const bibliotecas = require('./bibliotecas.cjs');
const indexador = require('./indexador.cjs');
const busqueda = require('./busqueda.cjs');
const etiquetas = require('./etiquetas.cjs');

const WEB = path.join(__dirname, '..', 'web', 'index.html');
const MIN_INACTIVO = Number(process.env.BUSCAR_INACTIVIDAD_MIN || 30);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

let puerto = 0;
let ultimoUso = Date.now();

function json(res, codigo, dato) {
  const cuerpo = JSON.stringify(dato);
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}
function error(res, codigo, mensaje) { json(res, codigo, { error: mensaje }); }

function leerCuerpo(req, max = 2e6) {
  return new Promise((resolve, reject) => {
    const partes = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > max) { reject(new Error('Demasiado grande')); req.destroy(); } else partes.push(d); });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

// Un archivo solo se sirve si está en el índice y su ruta real cae dentro de una biblioteca registrada.
function ubicar(id) {
  const r = indice.archivos.get(Number(id));
  if (!r) return null;
  const b = bibliotecas.porId(r.lib);
  if (!b) return null;
  let abs;
  try { abs = bibliotecas.rutaAbsoluta(b, r.rel); } catch { return null; }
  let existe = false;
  try {
    const real = fs.realpathSync(abs);
    existe = bibliotecas.dentro(real, fs.realpathSync(b.ruta)) && fs.statSync(real).isFile();
  } catch {}
  return { r, b, abs, existe };
}

function enviarArchivo(req, res, ruta, tipo, cache) {
  let st;
  try { st = fs.statSync(ruta); } catch { res.writeHead(404); return res.end(); }
  const cab = { 'content-type': tipo, 'accept-ranges': 'bytes', 'cache-control': cache || 'no-cache' };
  const rango = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rango && (rango[1] || rango[2])) {
    let ini = rango[1] ? +rango[1] : Math.max(0, st.size - +rango[2]);
    let fin = rango[1] && rango[2] ? Math.min(+rango[2], st.size - 1) : st.size - 1;
    if (ini > fin || ini >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...cab, 'content-range': `bytes ${ini}-${fin}/${st.size}`, 'content-length': fin - ini + 1 });
    return fs.createReadStream(ruta, { start: ini, end: fin }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...cab, 'content-length': st.size });
  fs.createReadStream(ruta).on('error', () => res.destroy()).pipe(res);
}

function lanzar(cmd, args, opciones) {
  try { const h = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opciones }); h.on('error', () => {}); h.unref(); return true; }
  catch { return false; }
}
function mostrarEnCarpeta(abs) {
  if (U.ES_MAC) return lanzar('open', ['-R', abs]);
  if (U.ES_WIN) return lanzar('explorer.exe', [`/select,"${abs}"`], { windowsVerbatimArguments: true });
  return lanzar('xdg-open', [path.dirname(abs)]);
}
function abrirConPrograma(abs) {
  if (U.ES_MAC) return lanzar('open', [abs]);
  if (U.ES_WIN) return lanzar('explorer.exe', [`"${abs}"`], { windowsVerbatimArguments: true });
  return lanzar('xdg-open', [abs]);
}

// Diálogo del sistema para elegir carpeta. Si no se puede, la interfaz deja escribir la ruta a mano.
function comandoElegirCarpeta(titulo, sistema) {
  if (sistema === 'mac') return { cmd: '/usr/bin/osascript', args: ['-e', 'tell me to activate', '-e', `POSIX path of (choose folder with prompt ${JSON.stringify(titulo)})`] };
  if (sistema === 'win') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${titulo.replace(/'/g, "''")}'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }`;
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', ps] };
  }
  return null;
}
async function elegirCarpeta(titulo) {
  const c = process.env.BUSCAR_SIN_DIALOGO ? null : comandoElegirCarpeta(titulo, U.ES_MAC ? 'mac' : U.ES_WIN ? 'win' : '');
  if (!c) return { ruta: null, sinDialogo: true };
  const r = await medios.correr(c.cmd, c.args, { espera: 300000 });
  if (r.codigo === 0) return { ruta: r.out.trim().replace(/[\\/]$/, '') || null };
  return { ruta: null, sinDialogo: U.ES_MAC ? !/-128/.test(r.err) : true }; // -128: la persona canceló
}

async function exportar(ids, destino) {
  if (!destino || !path.isAbsolute(destino)) throw new Error('Hace falta la ruta completa de la carpeta de destino.');
  for (const b of bibliotecas.todas()) if (bibliotecas.dentro(path.resolve(destino), b.ruta)) throw new Error('Elegí una carpeta fuera de las bibliotecas, así las copias no se mezclan con los originales.');
  await fs.promises.mkdir(destino, { recursive: true });
  const copiadas = [], omitidas = [];
  for (const id of ids) {
    const u = ubicar(id);
    if (!u) continue;
    if (!u.existe) { omitidas.push({ nombre: u.r._nombre, motivo: bibliotecas.conectada(u.b) ? 'el archivo ya no está' : 'disco desconectado' }); continue; }
    const ext = path.extname(u.r._nombre), base = path.basename(u.r._nombre, ext);
    let n = 1, hecho = false;
    while (!hecho && n < 500) { // nunca pisa un archivo que ya esté en el destino
      const dest = path.join(destino, n === 1 ? base + ext : `${base} (${n})${ext}`);
      try { await fs.promises.copyFile(u.abs, dest, fs.constants.COPYFILE_EXCL); copiadas.push(dest); hecho = true; }
      catch (e) { if (e.code === 'EEXIST') n++; else { omitidas.push({ nombre: u.r._nombre, motivo: e.code === 'ENOSPC' ? 'no hay espacio' : 'no se pudo copiar' }); break; } }
    }
  }
  return { destino, copiadas: copiadas.length, omitidas };
}

function estadoGeneral() {
  const s = busqueda.resumen();
  const e = indexador.estado;
  return {
    version: indice.version, fotos: s.fotos, videos: s.videos, conError: s.conError, sinCuadros: s.sinCuadros,
    bibliotecas: bibliotecas.todas().map(b => ({ id: b.id, uid: b.uid || '', nombre: b.nombre, ruta: b.ruta, conectada: bibliotecas.conectada(b), ...(s.libs.get(b.id) || { fotos: 0, videos: 0 }) })),
    clientes: s.clientes, anios: s.anios,
    ffmpeg: !!medios.buscarFfmpeg(),
    indexado: { activo: e.activo, fase: e.fase, biblioteca: e.biblioteca, total: e.total, hechas: e.hechas, porSeg: e.porSeg, falta: e.falta, aviso: e.aviso, ultimo: e.ultimo },
    ejemplos: busqueda.ejemplosActuales(),
    sistema: U.ES_MAC ? 'mac' : U.ES_WIN ? 'win' : 'otro', sep: path.sep,
    carpetaSugerida: path.join(os.homedir(), 'Desktop', 'Selección ' + new Date().toISOString().slice(0, 10)),
    indiceBytes: indice.tamanoEnDisco(),
    etq: etiquetas.resumen(),
  };
}

const rutas = {
  'GET /api/estado': async (req, res) => { etiquetas.refrescar(); json(res, 200, estadoGeneral()); },

  // antes de buscar se mira (como mucho cada 2 s) si llegaron etiquetas de otra compu: es solo comparar tamaño y fecha de unos pocos archivos
  'POST /api/buscar': async (req, res, cuerpo) => { etiquetas.refrescar(2000); json(res, 200, await busqueda.buscar(cuerpo)); },

  'POST /api/imagen': async (req, res, _c, crudo) => {
    try {
      const t = await medios.tensorDeImagen(crudo);
      const [v] = await modelo.vectoresDeImagenes([t]);
      json(res, 200, { ref: busqueda.guardarImagen(v) });
    } catch { error(res, 400, 'No pude leer esa imagen. Probá con un JPG o PNG.'); }
  },

  'GET /api/duplicados': async (req, res) => {
    const g = busqueda.duplicados();
    json(res, 200, { grupos: g.slice(0, 400), total: g.length });
  },

  'GET /api/fallidos': async (req, res) => {
    const l = [];
    for (const r of indice.archivos.values()) if (r.err && l.length < 500) l.push({ ...busqueda.ficha(r, 0, null, 0) });
    json(res, 200, { items: l });
  },

  'POST /api/accion': async (req, res, c) => {
    const u = ubicar(c.id);
    if (!u) return error(res, 404, 'Ese archivo ya no está en el índice.');
    if (!u.existe) return error(res, 200, bibliotecas.conectada(u.b) ? 'El archivo ya no está en esa carpeta. Actualizá la biblioteca.' : `El disco de "${u.b.nombre}" está desconectado.`);
    const ok = c.tipo === 'mostrar' ? mostrarEnCarpeta(u.abs) : c.tipo === 'abrir' ? abrirConPrograma(u.abs) : false;
    ok ? json(res, 200, { ok: true }) : error(res, 500, 'No pude abrirlo.');
  },

  'POST /api/elegir-carpeta': async (req, res, c) => json(res, 200, await elegirCarpeta(String(c.titulo || 'Elegí una carpeta').slice(0, 80))),

  'POST /api/exportar': async (req, res, c) => {
    try { json(res, 200, await exportar((c.ids || []).slice(0, 5000), c.destino)); }
    catch (e) { error(res, 400, e.message); }
  },

  'POST /api/bibliotecas': async (req, res, c) => {
    try {
      if (c.accion === 'agregar') { const b = bibliotecas.agregar(c.ruta, c.nombre); etiquetas.emparejar(); indexador.indexar({}).then(alTerminarIndexado); return json(res, 200, { ok: true, biblioteca: b }); }
      if (c.accion === 'mover') { const b = bibliotecas.mover(c.id, c.ruta); etiquetas.emparejar(); indice.tocar(); indexador.indexar({}).then(alTerminarIndexado); return json(res, 200, { ok: true, biblioteca: b }); }
      if (c.accion === 'quitar') {
        if (indexador.estado.activo) return error(res, 409, 'Esperá a que termine el indexado para quitar una biblioteca.');
        indexador.quitarBiblioteca(c.id); bibliotecas.quitar(c.id); return json(res, 200, { ok: true });
      }
      error(res, 400, 'Acción desconocida');
    } catch (e) { error(res, 200, e.message); }
  },

  'POST /api/indexar': async (req, res, c) => {
    if (c.cancelar) { indexador.cancelar(); return json(res, 200, { ok: true }); }
    indexador.indexar({ reintentar: !!c.reintentar }).then(alTerminarIndexado);
    json(res, 200, { ok: true });
  },

  'POST /api/etiquetar': async (req, res, c) => {
    try { json(res, 200, { ok: true, n: etiquetas.etiquetar(c.ids || [], c.agregar || [], c.quitar || []) }); } catch (e) { error(res, 200, e.message); }
  },

  'POST /api/usar': async (req, res, c) => {
    try { json(res, 200, { ok: true, n: etiquetas.marcarUso(c.ids || [], !!c.usada, c.nota, /^\d{4}-\d\d-\d\d$/.test(c.fecha || '') ? c.fecha : undefined) }); } catch (e) { error(res, 200, e.message); }
  },

  'POST /api/cliente': async (req, res, c) => {
    try {
      if (c.accion === 'regla') {
        const b = bibliotecas.porId(c.lib); if (!b) throw new Error('No encuentro esa biblioteca.');
        etiquetas.fijarCliente(b.id, c.carpeta || '', c.quitar ? null : String(c.cliente || ''));
      } else if (c.accion === 'renombrar') {
        if (!String(c.a || '').trim()) throw new Error('Falta el nombre nuevo.');
        etiquetas.renombrarCliente(String(c.de), String(c.a));
      } else throw new Error('Acción desconocida');
      json(res, 200, { ok: true });
    } catch (e) { error(res, 200, e.message); }
  },

  // carpeta: dónde se guardan las etiquetas (la que el equipo sincroniza por git); dejar: de vuelta solo en esta compu
  'POST /api/etiquetas-ubicacion': async (req, res, c) => {
    try {
      if (c.autor != null && String(c.autor).trim()) etiquetas.fijarAutor(c.autor);
      if (c.dejar) etiquetas.mudar(null);
      else if (c.carpeta) etiquetas.mudar(String(c.carpeta));
      json(res, 200, { ok: true, carpeta: etiquetas.ubicacion(), etq: etiquetas.resumen() });
    } catch (e) { error(res, 200, e.message); }
  },

  // lista acordada de etiquetas del equipo
  'POST /api/lista': async (req, res, c) => {
    try { json(res, 200, { ok: true, ...etiquetas.cambiarLista(c.agregar || [], c.quitar || []) }); } catch (e) { error(res, 200, e.message); }
  },

  // De rutas completas a ids del índice, para etiquetar o marcar desde la línea de comandos
  'POST /api/por-rutas': async (req, res, c) => {
    const ids = [], faltan = [];
    for (let ruta of (c.rutas || []).slice(0, 5000)) {
      let id = 0;
      try { ruta = fs.realpathSync(ruta); } catch {}
      for (const b of bibliotecas.todas()) {
        if (!bibliotecas.dentro(ruta, b.ruta)) continue;
        id = indice.porClave.get(indice.clave(b.id, path.relative(b.ruta, ruta).split(path.sep).join('/'))) || 0;
        if (id) break;
      }
      if (id) ids.push(id); else faltan.push(ruta);
    }
    json(res, 200, { ids, faltan });
  },

  'POST /api/cerrar': async (req, res) => { json(res, 200, { ok: true }); setTimeout(cerrar, 100); },
};

function alTerminarIndexado() { busqueda.calcularEjemplos().catch(() => {}); }

async function atender(req, res) {
  const anfitrion = String(req.headers.host || '');
  if (anfitrion !== `127.0.0.1:${puerto}` && anfitrion !== `localhost:${puerto}`) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://127.0.0.1');
  const ruta = url.pathname;
  if (ruta === '/api/vivo') return json(res, 200, { vivo: true, pid: process.pid }); // respuesta inmediata: sirve para saber si ya hay un buscador abierto
  if (ruta !== '/api/estado') ultimoUso = Date.now();

  if (req.method === 'GET' && (ruta === '/' || ruta === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    return res.end(fs.readFileSync(WEB));
  }

  let m;
  if (req.method === 'GET' && (m = /^\/mini\/(\d+)$/.exec(ruta))) {
    const t = url.searchParams.get('t');
    const f = medios.rutaMini(+m[1], t != null && /^\d+$/.test(t) ? +t : null);
    return enviarArchivo(req, res, f, 'image/webp', 'private, max-age=86400');
  }
  if (req.method === 'GET' && (m = /^\/original\/(\d+)$/.exec(ruta))) {
    const u = ubicar(m[1]);
    if (!u || !u.existe) { res.writeHead(404); return res.end(); }
    const ext = medios.extDe(u.abs);
    if (!MIME[ext]) { res.writeHead(415); return res.end(); }
    return enviarArchivo(req, res, u.abs, MIME[ext]);
  }
  if (req.method === 'GET' && (m = /^\/vista\/(\d+)$/.exec(ruta))) { // HEIC, RAW, PSD y TIFF: se convierten al vuelo para la vista rápida
    const u = ubicar(m[1]);
    if (!u || !u.existe || u.r.tipo !== 'f') { res.writeHead(404); return res.end(); }
    try {
      const { img, limpiar } = await medios.abrirFoto(u.abs);
      try {
        const buf = await img.resize(2200, 2200, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 86 }).toBuffer();
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=600', 'content-length': buf.length });
        return res.end(buf);
      } finally { limpiar(); }
    } catch { res.writeHead(404); return res.end(); }
  }

  const manejador = rutas[req.method + ' ' + ruta];
  if (!manejador) { res.writeHead(404); return res.end(); }
  let cuerpo = {}, crudo = null;
  if (req.method === 'POST') {
    // Encabezado propio: una página de otro sitio no puede mandarlo sin permiso, así nadie más dispara acciones.
    if (req.headers['x-buscador'] !== '1') { res.writeHead(403); return res.end(); }
    try {
      crudo = await leerCuerpo(req, ruta === '/api/imagen' ? 40e6 : 2e6);
      if (ruta !== '/api/imagen') cuerpo = crudo.length ? JSON.parse(crudo.toString('utf8')) : {};
    } catch { return error(res, 400, 'Pedido inválido'); }
  }
  try { await manejador(req, res, cuerpo, crudo); }
  catch (e) { if (!res.headersSent) error(res, 500, String(e.message || e).slice(0, 300)); }
}

async function cerrar() {
  try { fs.rmSync(U.ARCHIVO_SERVIDOR, { force: true }); } catch {}
  indexador.cancelar();
  await medios.cerrar();
  // onnxruntime aborta con un error ruidoso si el proceso sale de forma normal con el modelo cargado; acá ya está todo guardado
  modelo.soltarObrero();
  try { process.kill(process.pid, 'SIGKILL'); } catch {} // en Windows equivale a terminar el proceso en seco
  process.exit(0);
}

function escuchar(servidor, p, intentos) {
  return new Promise((resolve, reject) => {
    const alFallar = e => {
      if (e.code === 'EADDRINUSE' && intentos > 1) resolve(escuchar(servidor, p + 1, intentos - 1));
      else reject(e);
    };
    servidor.once('error', alFallar);
    servidor.listen(p, '127.0.0.1', () => { servidor.removeListener('error', alFallar); resolve(p); });
  });
}

// Si ya hay un buscador abierto para esta carpeta de datos, este no arranca: nunca dos servidores sobre el mismo índice.
function yaHayOtro() {
  const s = U.leerJson(U.ARCHIVO_SERVIDOR, null);
  if (!s || !s.puerto || s.pid === process.pid) return Promise.resolve(false);
  let procesoVivo = false; try { process.kill(s.pid, 0); procesoVivo = true; } catch {}
  if (!procesoVivo) return Promise.resolve(false);
  return new Promise(resolve => { // el proceso existe: se le da tiempo de sobra para contestar, por si está ocupado indexando
    const req = http.get({ host: '127.0.0.1', port: s.puerto, path: '/api/vivo', timeout: 20000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
  });
}

async function iniciar() {
  U.asegurarCarpetas();
  if (await yaHayOtro()) { console.log('Ya hay un buscador abierto: este no arranca.'); process.exit(0); }
  try { fs.rmSync(U.TMP, { recursive: true, force: true }); fs.mkdirSync(U.TMP, { recursive: true }); } catch {}
  etiquetas.iniciar();
  indice.cargar();
  const servidor = http.createServer((req, res) => { atender(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }); });
  puerto = await escuchar(servidor, U.PUERTO, 20);
  U.escribirJson(U.ARCHIVO_SERVIDOR, { pid: process.pid, puerto, inicio: Date.now() });
  console.log(`Buscador en http://127.0.0.1:${puerto}`);
  process.on('SIGINT', cerrar); process.on('SIGTERM', cerrar);
  setInterval(() => {
    if (!indexador.estado.activo && Date.now() - ultimoUso > MIN_INACTIVO * 60000) { console.log('Cierre por inactividad'); cerrar(); }
  }, 20000).unref();
  // deja el modelo de texto caliente y revisa si hay material nuevo, sin frenar el arranque
  busqueda.ordenar({ q: 'foto' }).catch(e => console.error('No pude cargar el modelo de texto:', e.message));
  if (bibliotecas.todas().length && !process.env.BUSCAR_SIN_REVISAR) indexador.indexar({}).then(alTerminarIndexado);
  else busqueda.calcularEjemplos().catch(() => {});
}

if (require.main === module) iniciar().catch(e => { console.error('No pude iniciar el buscador:', e.message); process.exit(1); });
module.exports = { comandoElegirCarpeta };
