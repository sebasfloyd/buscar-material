#!/usr/bin/env node
// Buscador local de fotos y videos. Uso: node buscar.cjs <comando>
//   preparar | abrir | biblioteca agregar|listar|quitar | indexar | estado | buscar "<texto>" | duplicados | cerrar
//   etiquetar | marcar-usada | etiquetas listar|ubicacion | cliente asignar|renombrar | actualizar | version
// No necesita dependencias propias: las instala "preparar" en ~/.mente-ai/buscar-material.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const U = require('./motor/util.cjs');

const ENTORNO = path.join(__dirname, 'entorno.json');
const MARCA = path.join(U.HOME, 'preparado.json');
const args = process.argv.slice(2);
const comando = args.shift() || 'ayuda';

function opcion(nombre, defecto) {
  const i = args.indexOf('--' + nombre);
  if (i < 0) return defecto;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? true : v;
}
function salir(mensaje, codigo = 1) { console.error(mensaje); process.exit(codigo); }
function mega(b) { return (b / 1048576).toFixed(b > 104857600 ? 0 : 1).replace('.', ',') + ' MB'; }
const dormir = ms => new Promise(r => setTimeout(r, ms));

function pesoDe(dir) {
  let t = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); t += e.isDirectory() ? pesoDe(p) : e.isFile() ? fs.statSync(p).size : 0; } } catch {}
  return t;
}

// ---------- preparación ----------
function entorno() { return JSON.parse(fs.readFileSync(ENTORNO, 'utf8')); }
// Solo cuenta lo que hay que instalar: un cambio de versión sin dependencias nuevas no obliga a preparar de nuevo.
function firmaEntorno() { const e = entorno(); return crypto.createHash('sha1').update(JSON.stringify([e.dependencies, e.overrides])).digest('hex').slice(0, 12); }
function estaPreparado() {
  const m = U.leerJson(MARCA, null);
  return !!m && m.entorno === firmaEntorno() && fs.existsSync(path.join(U.HOME, 'node_modules', 'sharp'));
}

function npm() {
  const dir = path.dirname(fs.realpathSync(process.execPath));
  for (const c of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')])
    if (fs.existsSync(c)) return { cmd: process.execPath, base: [c], shell: false };
  return { cmd: U.ES_WIN ? 'npm.cmd' : 'npm', base: [], shell: U.ES_WIN };
}

// onnxruntime trae binarios para todos los sistemas (unos 180 MB de más): se dejan solo los de esta compu.
function podar() {
  const base = path.join(U.HOME, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  try {
    for (const so of fs.readdirSync(base)) for (const arq of fs.readdirSync(path.join(base, so)))
      if (so !== process.platform || arq !== process.arch) fs.rmSync(path.join(base, so, arq), { recursive: true, force: true });
  } catch {}
}

async function preparar() {
  const mayor = Number(process.versions.node.split('.')[0]);
  if (mayor < 18) salir(`Hace falta Node 18 o más nuevo (esta compu tiene ${process.versions.node}).`);
  U.asegurarCarpetas();
  if (!estaPreparado()) {
    console.log('Instalando las herramientas (una sola vez)…');
    const e = entorno();
    fs.writeFileSync(path.join(U.HOME, 'package.json'), JSON.stringify({ name: e.name, private: true, version: '1.0.0', dependencies: e.dependencies, overrides: e.overrides }, null, 1));
    const n = npm();
    // en Windows la variable se llama "Path": se respeta el nombre que ya tenga para no dejar dos
    const env = { ...process.env }, kPath = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    env[kPath] = path.dirname(process.execPath) + path.delimiter + (env[kPath] || '');
    const r = spawnSync(n.cmd, [...n.base, 'install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], { cwd: U.HOME, stdio: 'inherit', shell: n.shell, env });
    if (r.status !== 0) salir('No se pudieron instalar las herramientas. Revisá la conexión a internet y volvé a correr "preparar".');
    podar();
  }
  console.log('Comprobando el modelo (la primera vez baja unos 530 MB)…');
  const modelo = require('./motor/modelo.cjs');
  try {
    await modelo.texto(); await modelo.vision();
    const v = await modelo.vectorDeTexto('prueba');
    if (v.length !== modelo.DIM) throw new Error('el modelo devolvió un vector inesperado');
    const medios = require('./motor/medios.cjs');
    await medios.sharp()({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).webp().toBuffer();
  } catch (e) { salir('No pude dejar listo el modelo: ' + (e.message || e) + '\nSi fue por la conexión, volvé a correr "preparar": retoma donde quedó.'); }
  await modelo.liberar();
  U.escribirJson(MARCA, { entorno: firmaEntorno(), fecha: new Date().toISOString(), node: process.versions.node, sistema: process.platform + '-' + process.arch });
  const acceso = crearAcceso();
  console.log(JSON.stringify({ listo: true, version: entorno().version, accesoDirecto: acceso || undefined, herramientas: mega(pesoDe(path.join(U.HOME, 'node_modules'))), modelo: mega(pesoDe(U.MODELOS)), carpeta: U.HOME }));
}

// ---------- acceso directo para abrir el buscador sin pasar por Claude ----------
function escritorio() {
  if (process.env.BUSCAR_ESCRITORIO) return process.env.BUSCAR_ESCRITORIO;
  if (U.ES_WIN) { // el Escritorio puede estar redirigido (OneDrive): se le pregunta a Windows dónde está
    try { const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); const d = (r.stdout || '').trim(); if (d && fs.existsSync(d)) return d; } catch {}
  }
  for (const d of [path.join(require('os').homedir(), 'Desktop'), path.join(require('os').homedir(), 'Escritorio')]) if (fs.existsSync(d)) return d;
  return null;
}
function crearAcceso() {
  try {
    const dir = escritorio();
    if (!dir) return null;
    if (U.ES_WIN) {
      const f = path.join(dir, 'Buscar material.cmd');
      fs.writeFileSync(f, `@echo off\r\nrem Abre el buscador de fotos y videos. Si ya esta abierto, solo muestra la ventana.\r\ncall "${path.join(__dirname, 'buscar.cmd')}" abrir >nul\r\nif errorlevel 1 (\r\n  echo No se pudo abrir el buscador. Pedile a la Mente: "abri el buscador de material".\r\n  pause\r\n)\r\n`);
      return f;
    }
    if (U.ES_MAC) {
      const app = path.join(dir, 'Buscar material.app'), bin = path.join(app, 'Contents', 'MacOS');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>Buscar material</string>\n<key>CFBundleIdentifier</key><string>local.buscar-material</string>\n<key>CFBundleExecutable</key><string>abrir</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>LSUIElement</key><true/>\n</dict></plist>\n`);
      const guion = path.join(bin, 'abrir');
      fs.writeFileSync(guion, `#!/bin/sh\n# Abre el buscador de fotos y videos. Si ya está abierto, solo muestra la ventana.\nsh "${path.join(__dirname, 'buscar.sh').replace(/(["$\`\\])/g, '\\$1')}" abrir >/dev/null 2>&1 || /usr/bin/osascript -e 'display dialog "No se pudo abrir el buscador. Pedile a la Mente: abrí el buscador de material." buttons {"Entendido"} default button 1 with title "Buscar material"' >/dev/null 2>&1\n`);
      fs.chmodSync(guion, 0o755);
      return app;
    }
    const f = path.join(dir, 'buscar-material.sh');
    fs.writeFileSync(f, `#!/bin/sh\nsh "${path.join(__dirname, 'buscar.sh')}" abrir\n`); fs.chmodSync(f, 0o755);
    return f;
  } catch { return null; }
}

// ---------- actualización (instalación por git) ----------
function novedades(desde) { // entradas del CHANGELOG más nuevas que la versión que había
  let texto = ''; try { texto = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch { return []; }
  const partes = texto.split(/^## /m).slice(1), res = [];
  for (const p of partes) { const v = p.split(/[\s·]/)[0]; if (v === desde) break; res.push({ version: v, cambios: p.split('\n').slice(1).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean) }); }
  return res;
}
async function actualizar() {
  const antes = entorno().version, firma = firmaEntorno();
  if (!fs.existsSync(path.join(__dirname, '.git'))) {
    return console.log(JSON.stringify({ actualizado: false, version: antes, motivo: 'Esta copia se instaló desde un zip. Para actualizar, pedí el zip nuevo e instalalo encima: el índice y las etiquetas no se pierden porque viven fuera de la skill.' }));
  }
  const git = (...a) => spawnSync('git', ['-C', __dirname, ...a], { encoding: 'utf8', windowsHide: true });
  if (git('--version').status !== 0) salir('No encuentro git en esta compu, así que no puedo traer la versión nueva.');
  const r = git('pull', '--ff-only');
  if (r.status !== 0) salir('No pude traer la versión nueva: ' + (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ') + '\nNo se cambió nada.');
  const ahora = entorno().version;
  const cambios = ahora === antes ? [] : novedades(antes);
  let preparado = false;
  if (firmaEntorno() !== firma || !estaPreparado()) { await preparar(); preparado = true; } else crearAcceso();
  const puerto = await servidorVivo(); // el buscador abierto sigue con el código viejo hasta que se cierra
  if (puerto && ahora !== antes) await pedir(puerto, 'POST', '/api/cerrar', {}).catch(() => {});
  console.log(JSON.stringify({ actualizado: ahora !== antes, de: antes, a: ahora, cambios, herramientasReinstaladas: preparado || undefined, nota: ahora === antes ? 'Ya estaba al día.' : 'El índice, las miniaturas y las etiquetas no se tocaron.' + (puerto ? ' El buscador se cerró para tomar la versión nueva: volvé a abrirlo.' : '') }));
}

// ---------- servidor ----------
function pedir(puerto, metodo, ruta, cuerpo, espera = 600000) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo === undefined ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: metodo, timeout: espera, headers: { 'x-buscador': '1', ...(datos ? { 'content-type': 'application/json', 'content-length': datos.length } : {}) } }, res => {
      const p = [];
      res.on('data', d => p.push(d));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(p).toString('utf8')); } catch {} resolve({ codigo: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('sin respuesta')));
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

async function servidorVivo() {
  const s = U.leerJson(U.ARCHIVO_SERVIDOR, null);
  if (!s || !s.puerto) return 0;
  try { const r = await pedir(s.puerto, 'GET', '/api/estado', undefined, 2500); return r.codigo === 200 && r.json && 'fotos' in r.json ? s.puerto : 0; }
  catch { return 0; }
}

async function asegurarServidor() {
  let puerto = await servidorVivo();
  if (puerto) return puerto;
  if (!estaPreparado()) salir('Falta la preparación de la primera vez. Corré: node buscar.cjs preparar');
  // Dos aperturas casi al mismo tiempo (doble clic en el acceso directo): solo una arranca el servidor; la otra espera.
  U.asegurarCarpetas();
  const candado = path.join(U.HOME, 'arranque.lock');
  let mio = false;
  for (let i = 0; i < 160 && !mio; i++) {
    try { fs.closeSync(fs.openSync(candado, 'wx')); mio = true; }
    catch { try { if (Date.now() - fs.statSync(candado).mtimeMs > 45000) fs.rmSync(candado, { force: true }); } catch {} await dormir(250); if ((puerto = await servidorVivo())) return puerto; }
  }
  const soltar = () => { try { fs.rmSync(candado, { force: true }); } catch {} };
  if ((puerto = await servidorVivo())) { soltar(); return puerto; }
  const registro = fs.openSync(path.join(U.HOME, 'servidor.log'), 'a');
  fs.rmSync(U.ARCHIVO_SERVIDOR, { force: true });
  const hijo = spawn(process.execPath, [path.join(__dirname, 'motor', 'servidor.cjs')], { detached: true, stdio: ['ignore', registro, registro], windowsHide: true, env: process.env });
  hijo.unref();
  for (let i = 0; i < 120; i++) { await dormir(250); if ((puerto = await servidorVivo())) { soltar(); return puerto; } }
  soltar();
  salir('El buscador no arrancó. El detalle está en ' + path.join(U.HOME, 'servidor.log'));
}

async function api(metodo, ruta, cuerpo) {
  const puerto = await asegurarServidor();
  const r = await pedir(puerto, metodo, ruta, cuerpo);
  if (r.codigo !== 200 || (r.json && r.json.error)) salir((r.json && r.json.error) || `El buscador respondió ${r.codigo}`);
  return r.json;
}

function abrirNavegador(url) {
  const [cmd, a, o] = U.ES_MAC ? ['open', [url], {}] : U.ES_WIN ? ['cmd.exe', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }] : ['xdg-open', [url], {}];
  try { const h = spawn(cmd, a, { detached: true, stdio: 'ignore', ...o }); h.on('error', () => {}); h.unref(); } catch {}
}

function rutaDe(estado, it) {
  const b = estado.bibliotecas.find(x => x.id === it.l);
  return b ? path.join(b.ruta, ...(it.d ? it.d.split('/') : []), it.n) : it.n;
}

async function esperarIndexado(silencio) {
  let ultimo = 0;
  for (;;) {
    const e = await api('GET', '/api/estado');
    const x = e.indexado;
    if (!x.activo) return e;
    if (!silencio && Date.now() - ultimo > 10000) {
      ultimo = Date.now();
      console.error(x.fase === 'revisando' ? `Revisando ${x.biblioteca}…` : `Indexando ${x.hechas} de ${x.total}` + (x.falta ? ` · faltan unos ${x.falta < 90 ? x.falta + ' s' : Math.round(x.falta / 60) + ' min'}` : ''));
    }
    await dormir(1500);
  }
}

async function idsDeRutas() {
  const lista = opcion('lista', '');
  let rutas = args.splice(0);
  if (typeof lista === 'string' && lista) rutas = rutas.concat(fs.readFileSync(lista, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  if (!rutas.length) salir('Faltan las rutas de los archivos (o --lista archivo.txt).');
  return api('POST', '/api/por-rutas', { rutas: rutas.map(r => path.resolve(r)) });
}

const comandos = {
  async preparar() { await preparar(); },

  async abrir() {
    const puerto = await asegurarServidor();
    const url = `http://127.0.0.1:${puerto}/`;
    if (!opcion('sin-navegador', false) && !process.env.BUSCAR_SIN_NAVEGADOR) abrirNavegador(url);
    console.log(JSON.stringify({ url }));
  },

  async biblioteca() {
    const sub = args.shift();
    if (sub === 'agregar') {
      const nombre = opcion('nombre', undefined);
      const ruta = args.shift();
      if (!ruta) salir('Falta la carpeta. Ejemplo: node buscar.cjs biblioteca agregar "/Volumes/Disco/Clientes"');
      const r = await api('POST', '/api/bibliotecas', { accion: 'agregar', ruta: path.resolve(ruta), nombre: typeof nombre === 'string' ? nombre : undefined });
      console.log(JSON.stringify({ agregada: r.biblioteca, nota: 'El indexado arrancó solo. Seguilo con "estado" o "indexar".' }));
    } else if (sub === 'mover') { // biblioteca mover "<nombre>" "<carpeta nueva>": mismo material en otra ruta o letra de disco, sin reindexar
      const cual = args.shift(), ruta = args.shift();
      const e = await api('GET', '/api/estado');
      const b = e.bibliotecas.find(x => x.id === cual || x.nombre === cual);
      if (!b || !ruta) salir('Uso: biblioteca mover "<nombre>" "<carpeta nueva>"');
      await esperarIndexado(true);
      const r = await api('POST', '/api/bibliotecas', { accion: 'mover', id: b.id, ruta: path.resolve(ruta) });
      console.log(JSON.stringify({ movida: r.biblioteca.nombre, ruta: r.biblioteca.ruta, nota: 'El índice y las etiquetas se conservan.' }));
    } else if (sub === 'quitar') {
      const cual = args.shift();
      const e = await api('GET', '/api/estado');
      const b = e.bibliotecas.find(x => x.id === cual || x.nombre === cual || x.ruta === cual);
      if (!b) salir('No hay una biblioteca con ese nombre. Mirá "biblioteca listar".');
      await esperarIndexado(true); // al abrir revisa solo si hay novedades: se espera a que termine
      await api('POST', '/api/bibliotecas', { accion: 'quitar', id: b.id });
      console.log(JSON.stringify({ quitada: b.nombre, nota: 'Solo se quitó del buscador. Los archivos originales no se tocaron.' }));
    } else {
      const e = await api('GET', '/api/estado');
      console.log(JSON.stringify(e.bibliotecas));
    }
  },

  async indexar() {
    const reintentar = !!opcion('reintentar', false), sinEsperar = !!opcion('sin-esperar', false);
    await api('POST', '/api/indexar', { reintentar });
    await dormir(300);
    if (sinEsperar) return console.log(JSON.stringify({ indexando: true }));
    const e = await esperarIndexado(false);
    console.log(JSON.stringify({ fotos: e.fotos, videos: e.videos, sinMiniatura: e.conError, videosSoloPorNombre: e.sinCuadros, ffmpeg: e.ffmpeg, ultimo: e.indexado.ultimo, aviso: e.indexado.aviso || undefined, indice: mega(e.indiceBytes) }));
  },

  async estado() {
    const e = await api('GET', '/api/estado');
    console.log(JSON.stringify({ fotos: e.fotos, videos: e.videos, sinMiniatura: e.conError, videosSoloPorNombre: e.sinCuadros, ffmpeg: e.ffmpeg, bibliotecas: e.bibliotecas, clientes: e.clientes.map(c => c.nombre), indexado: e.indexado, indice: mega(e.indiceBytes) }));
  },

  async buscar() {
    const n = Number(opcion('n', 20));
    const tipo = opcion('tipo', ''), orient = opcion('orientacion', ''), bib = opcion('biblioteca', '');
    const filtros = {
      cliente: opcion('cliente', '') || undefined, desde: opcion('desde', '') || undefined, hasta: opcion('hasta', '') || undefined,
      tipo: tipo ? ({ foto: 'f', fotos: 'f', video: 'v', videos: 'v' })[tipo] : undefined,
      orient: orient ? ({ vertical: 'v', horizontal: 'h', cuadrada: 'c' })[orient] : undefined,
    };
    const etq = opcion('etiqueta', ''); if (typeof etq === 'string' && etq) filtros.etiquetas = etq.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (opcion('sin-usar', false)) filtros.uso = 'sin'; else if (opcion('usadas', false)) filtros.uso = 'usada';
    const orden = opcion('orden', '') === 'fecha' ? 'fecha' : '';
    const e = await api('GET', '/api/estado');
    if (bib) { const b = e.bibliotecas.find(x => x.id === bib || x.nombre === bib); if (b) filtros.lib = b.id; }
    const r = await api('POST', '/api/buscar', { q: args.join(' '), filtros, orden, limite: n });
    console.log(JSON.stringify({
      total: r.total, coinciden: r.coinciden, ms: r.ms,
      resultados: r.items.map((it, i) => {
        const o = { ruta: rutaDe(e, it), puntaje: it.p };
        if (i >= r.coinciden) o.relacionada = true;
        if (it.c) o.cliente = it.c;
        if (it.et && it.et.length) o.etiquetas = it.et;
        if (it.us) o.usada = it.us.n ? it.us.f + ' · ' + it.us.n : it.us.f;
        if (it.t != null) o.segundo = it.t;
        if (it.nm) o.porNombre = true;
        if (!e.bibliotecas.find(b => b.id === it.l)?.conectada) o.desconectado = true;
        return o;
      }),
    }));
  },

  async duplicados() {
    const e = await api('GET', '/api/estado');
    const d = await api('GET', '/api/duplicados');
    console.log(JSON.stringify({ grupos: d.total, lista: d.grupos.slice(0, Number(opcion('n', 50))).map(g => ({ tipo: g.exacto ? 'idénticas' : 'casi iguales', rutas: g.items.map(it => rutaDe(e, it)) })) }));
  },

  // etiquetar <rutas…> --agregar "a,b" [--quitar "c"]   (o --lista archivo.txt con una ruta por línea)
  async etiquetar() {
    const mas = String(opcion('agregar', '') || '').split(',').map(x => x.trim()).filter(Boolean);
    const menos = String(opcion('quitar', '') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!mas.length && !menos.length) salir('Decí qué etiquetas: --agregar "plato,verano" o --quitar "borrador".');
    const { ids, faltan } = await idsDeRutas();
    const r = await api('POST', '/api/etiquetar', { ids, agregar: mas, quitar: menos });
    console.log(JSON.stringify({ etiquetadas: r.n, noEncontradas: faltan.length ? faltan : undefined }));
  },

  // marcar-usada <rutas…> [--nota "Instagram 12/11"] [--fecha AAAA-MM-DD] [--deshacer]
  async 'marcar-usada'() {
    const nota = opcion('nota', undefined), fecha = opcion('fecha', undefined), deshacer = !!opcion('deshacer', false);
    const { ids, faltan } = await idsDeRutas();
    const r = await api('POST', '/api/usar', { ids, usada: !deshacer, nota: typeof nota === 'string' ? nota : undefined, fecha: typeof fecha === 'string' ? fecha : undefined });
    console.log(JSON.stringify({ [deshacer ? 'desmarcadas' : 'marcadas']: r.n, noEncontradas: faltan.length ? faltan : undefined }));
  },

  async etiquetas() {
    const sub = args.shift();
    if (sub === 'ubicacion') {
      const dir = args.shift();
      if (!dir) { const e = await api('GET', '/api/estado'); return console.log(JSON.stringify({ carpeta: e.etq.carpeta })); }
      const r = await api('POST', '/api/etiquetas-ubicacion', { carpeta: path.resolve(dir) });
      return console.log(JSON.stringify({ carpeta: r.carpeta, nota: 'Las etiquetas que ya había en los dos lugares se unieron.' }));
    }
    const e = await api('GET', '/api/estado');
    console.log(JSON.stringify({ etiquetas: e.etq.etiquetas, usadas: e.etq.usadas, clientesPorCarpeta: e.etq.reglas, carpeta: e.etq.carpeta }));
  },

  // cliente asignar "<carpeta>" "<Cliente>"  ·  cliente renombrar "<actual>" "<nuevo>"  (si el nuevo ya existe, los une)
  async cliente() {
    const sub = args.shift();
    if (sub === 'asignar') {
      const dir = args.shift(), nombre = args.shift();
      if (!dir || nombre === undefined) salir('Uso: cliente asignar "<carpeta>" "<Cliente>"');
      const e = await api('GET', '/api/estado');
      let real = path.resolve(dir); try { real = fs.realpathSync(real); } catch {}
      const b = e.bibliotecas.filter(x => { const rel = path.relative(x.ruta, real); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })[0];
      if (!b) salir('Esa carpeta no está dentro de ninguna biblioteca. Mirá "biblioteca listar".');
      const carpeta = path.relative(b.ruta, real).split(path.sep).join('/');
      await api('POST', '/api/cliente', { accion: 'regla', lib: b.id, carpeta, cliente: nombre });
      return console.log(JSON.stringify({ biblioteca: b.nombre, carpeta: carpeta || '(toda)', cliente: nombre }));
    }
    if (sub === 'renombrar') {
      const de = args.shift(), a = args.shift();
      if (!de || !a) salir('Uso: cliente renombrar "<actual>" "<nuevo>"');
      await api('POST', '/api/cliente', { accion: 'renombrar', de, a });
      return console.log(JSON.stringify({ de, a }));
    }
    const e = await api('GET', '/api/estado');
    console.log(JSON.stringify({ clientes: e.clientes.map(c => ({ nombre: c.nombre, archivos: c.n })), reglas: e.etq.reglas }));
  },

  async actualizar() { await actualizar(); },

  async version() { console.log(JSON.stringify({ version: entorno().version, instaladaCon: fs.existsSync(path.join(__dirname, '.git')) ? 'git' : 'zip', carpeta: __dirname, datos: U.HOME })); },

  async cerrar() {
    const puerto = await servidorVivo();
    if (!puerto) return console.log(JSON.stringify({ cerrado: true, nota: 'No estaba abierto.' }));
    await pedir(puerto, 'POST', '/api/cerrar', {}).catch(() => {});
    console.log(JSON.stringify({ cerrado: true }));
  },

  async ayuda() {
    console.log('Comandos: preparar · abrir · biblioteca agregar "<carpeta>" [--nombre X] · biblioteca listar · biblioteca quitar <nombre> · indexar [--reintentar] · estado · buscar "<texto>" [--n 20 --cliente X --tipo foto|video --orientacion vertical|horizontal|cuadrada --desde AAAA-MM-DD --hasta AAAA-MM-DD --orden fecha] · duplicados · etiquetar <rutas> --agregar "a,b" · marcar-usada <rutas> [--nota X] · etiquetas listar|ubicacion "<carpeta>" · cliente asignar "<carpeta>" "<Cliente>" · cliente renombrar "<A>" "<B>" · actualizar · version · cerrar');
  },
};

// "preparar" carga el modelo en este proceso: se lo deja terminar solo, porque un exit forzado hace abortar a onnxruntime
(comandos[comando] || comandos.ayuda)().then(() => { if (comando !== 'preparar') process.exit(0); }).catch(e => salir(String(e && e.message || e)));
