// Prueba de punta a punta del buscador, usando el lanzador real de cada sistema. La corre GitHub Actions.
// No forma parte de la skill: quien la instala no necesita esta carpeta.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const TRABAJO = path.join(os.tmpdir(), 'buscar pruebas'); // con espacio a propósito
const BANCO = path.join(TRABAJO, 'Material de prueba');
const SALIDA = path.join(RAIZ, 'pruebas', 'salida');
fs.rmSync(TRABAJO, { recursive: true, force: true }); fs.mkdirSync(BANCO, { recursive: true }); fs.mkdirSync(SALIDA, { recursive: true });
const R = { sistema: `${process.platform}-${process.arch}`, cpu: os.cpus()[0].model, nucleos: os.cpus().length, node: process.version, pasos: {}, busquedas: [], fallas: [] };
const UA = { 'User-Agent': 'buscar-material-ci/1.0 (pruebas automaticas)' };

function comillas(a) { return WIN ? `"${String(a).replace(/"/g, '""')}"` : `'${String(a).replace(/'/g, `'\\''`)}'`; }
function buscar(...args) {
  const cmd = (WIN ? comillas(path.join(RAIZ, 'buscar.cmd')) : 'sh ' + comillas(path.join(RAIZ, 'buscar.sh'))) + ' ' + args.map(comillas).join(' ');
  const t = Date.now();
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: { ...process.env, BUSCAR_SIN_NAVEGADOR: '1' }, maxBuffer: 64e6, windowsHide: true });
  const ms = Date.now() - t;
  if (r.status !== 0) throw new Error(`"${args.join(' ')}" salió con ${r.status}\n${r.stdout}\n${r.stderr}`);
  const linea = r.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('{') || l.startsWith('[')).pop();
  let json = null; try { json = JSON.parse(linea); } catch {}
  return { json, ms, salida: r.stdout, err: r.stderr };
}
function comprobar(cond, nombre, detalle = '') { if (cond) console.log('  ok  ' + nombre); else { console.log('  FALLA  ' + nombre + ' ' + detalle); R.fallas.push(nombre + ' ' + detalle); } }
async function bajar(url, destino, intentos = 6) {
  for (let i = 0; i < intentos; i++) {
    try { const r = await fetch(url, { headers: UA, redirect: 'follow' }); if (r.ok) { fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer())); return true; } if (r.status === 404) return false; }
    catch {}
    await new Promise(x => setTimeout(x, 4000 * (i + 1)));
  }
  return false;
}
async function commons(consulta, cuantas) {
  const u = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: consulta + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: '20', prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '960', format: 'json' });
  for (let i = 0; i < 6; i++) {
    try {
      const j = await (await fetch(u, { headers: UA })).json();
      return Object.values(j.query.pages).sort((a, b) => a.index - b.index).map(p => p.imageinfo[0]).filter(x => x.mime === 'image/jpeg' && x.width >= 700).slice(0, cuantas + 4).map(x => x.thumburl);
    } catch { await new Promise(x => setTimeout(x, 5000 * (i + 1))); }
  }
  return [];
}

const TEMAS = { pizza: 'pizza napoletana', sushi: 'sushi nigiri maki', perro: 'dog portrait', bicicleta: 'bicycle parked', playa: 'tropical beach sea', guitarra: 'acoustic guitar' };
const etiquetaDe = {}; // nombre de archivo -> tema

async function armarBanco() {
  let n = 0;
  for (const [tema, consulta] of Object.entries(TEMAS)) {
    const carpeta = path.join(BANCO, n % 2 ? 'Cliente Dos' : 'Cliente Uno', 'sesión ' + (1 + (n % 3)));
    fs.mkdirSync(carpeta, { recursive: true });
    let hechas = 0;
    for (const url of await commons(consulta, 5)) {
      const nombre = `IMG_${String(1000 + (++n)).padStart(4, '0')}.jpg`;
      if (await bajar(url, path.join(carpeta, nombre), 3)) { etiquetaDe[nombre] = tema; hechas++; } else n--;
      await new Promise(x => setTimeout(x, 700));
      if (hechas >= 5) break;
    }
    console.log(`  ${tema}: ${hechas} fotos`);
    if (hechas < 3) throw new Error('No pude bajar suficientes fotos de ' + tema);
  }
  const raros = path.join(BANCO, 'Cliente Uno', 'formatos');
  fs.mkdirSync(raros, { recursive: true });
  R.pasos.heic = await bajar('https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic', path.join(raros, 'foto_celular.heic'));
  R.pasos.raw = await bajar('https://raw.pixls.us/data/Canon/EOS%20550D/IMG_4047.CR2', path.join(raros, 'camara_reflex.CR2'), 4);
  // video corto armado con las fotos de bicicletas (hace falta ffmpeg, que el workflow instala)
  const bicis = Object.entries(etiquetaDe).filter(([, t]) => t === 'bicicleta').map(([f]) => f);
  const dirBici = path.dirname(fs.readdirSync(BANCO, { recursive: true }).map(f => path.join(BANCO, String(f))).find(f => f.endsWith(bicis[0])));
  const lista = path.join(TRABAJO, 'lista.txt');
  fs.writeFileSync(lista, bicis.slice(0, 3).map(f => `file '${path.join(dirBici, f).replace(/\\/g, '/')}'\nduration 2\n`).join(''));
  const v = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-r', '10', path.join(raros, 'paseo corto.mp4')], { encoding: 'utf8' });
  R.pasos.video = v.status === 0;
  if (v.status !== 0) console.log('  ffmpeg:', v.error ? v.error.message : v.stderr);
  R.pasos.fotos = n;
}

const temaDe = ruta => etiquetaDe[path.basename(ruta)] || path.basename(ruta);

async function principal() {
  console.log('1. Preparar desde cero');
  let r = buscar('preparar'); R.pasos.prepararSeg = Math.round(r.ms / 1000); R.pasos.preparar = r.json;
  comprobar(r.json && r.json.listo, 'preparar termina', r.salida.slice(-300));
  r = buscar('preparar'); R.pasos.prepararDeNuevoSeg = Math.round(r.ms / 1000);
  comprobar(r.json && r.json.listo, 'preparar por segunda vez no rompe nada');

  console.log('2. Banco de prueba'); await armarBanco();
  comprobar(R.pasos.heic, 'HEIC descargado'); comprobar(R.pasos.raw, 'RAW descargado'); comprobar(R.pasos.video, 'video generado');

  console.log('3. Biblioteca e indexado');
  r = buscar('biblioteca', 'agregar', BANCO, '--nombre', 'Prueba'); comprobar(r.json && r.json.agregada, 'biblioteca agregada');
  r = buscar('indexar'); const ix = r.json; R.pasos.indexado = ix;
  const total = R.pasos.fotos + 3;
  comprobar(ix && ix.fotos + ix.videos === total, `indexa los ${total} archivos`, JSON.stringify(ix));
  comprobar(ix && ix.sinMiniatura === 0, 'todos con miniatura (HEIC y RAW incluidos)', JSON.stringify(ix && ix.sinMiniatura));
  comprobar(ix && ix.videosSoloPorNombre === 0 && ix.ffmpeg, 'el video se indexó por dentro');
  R.pasos.imagenesPorSegundo = ix && ix.ultimo ? ix.ultimo.porSeg : null;

  console.log('4. Búsquedas en español');
  const casos = [['pizza', 'pizza'], ['sushi', 'sushi'], ['un perro', 'perro'], ['bicicleta', 'bicicleta'], ['playa con mar', 'playa'], ['guitarra', 'guitarra'], ['comida japonesa', 'sushi'], ['instrumento musical', 'guitarra'], ['mascota', 'perro'], ['niguiris de salmón', 'sushi']];
  for (const [q, esperado] of casos) {
    r = buscar('buscar', q, '--n', '5', '--tipo', 'foto');
    const tops = (r.json ? r.json.resultados : []).map(x => temaDe(x.ruta));
    const aciertos = tops.slice(0, 3).filter(t => t === esperado).length;
    R.busquedas.push({ consulta: q, esperado, primeros: tops, msMotor: r.json && r.json.ms, msComando: r.ms, coinciden: r.json && r.json.coinciden });
    comprobar(tops[0] === esperado && aciertos >= 2, `"${q}" trae ${esperado}`, tops.join(','));
  }
  r = buscar('buscar', 'bicicleta', '--tipo', 'video', '--n', '3');
  comprobar(r.json && r.json.resultados[0] && /paseo corto\.mp4$/.test(r.json.resultados[0].ruta) && r.json.resultados[0].segundo != null, 'el video aparece con su segundo', JSON.stringify(r.json));
  r = buscar('buscar', 'jirafa en la nieve', '--n', '5');
  R.pasos.sinRespuesta = r.json && { coinciden: r.json.coinciden, total: r.json.total };
  comprobar(r.json && r.json.coinciden === 0, 'lo que no existe no da coincidencias', JSON.stringify(R.pasos.sinRespuesta));
  r = buscar('buscar', 'foto_celular.heic'); comprobar(r.json && r.json.total === 1, 'encuentra el HEIC por nombre');
  r = buscar('buscar', 'camara_reflex.CR2'); comprobar(r.json && r.json.total === 1, 'encuentra el RAW por nombre');

  console.log('5. Etiquetas y material usado');
  const pizzas = buscar('buscar', 'pizza', '--n', '3', '--tipo', 'foto').json.resultados.map(x => x.ruta);
  r = buscar('etiquetar', pizzas[0], pizzas[1], '--agregar', 'promoción de verano,aprobada'); comprobar(r.json && r.json.etiquetadas === 2, 'etiqueta dos fotos', JSON.stringify(r.json));
  r = buscar('marcar-usada', pizzas[0], '--nota', 'Publicación de prueba'); comprobar(r.json && r.json.marcadas === 1, 'marca una como usada');
  r = buscar('buscar', '--etiqueta', 'promoción de verano', '--sin-usar'); comprobar(r.json && r.json.total === 1, 'filtra por etiqueta y sin usar', JSON.stringify(r.json));
  r = buscar('buscar', 'promoción de verano', '--n', '2'); comprobar(r.json && r.json.resultados[0] && r.json.resultados[0].porNombre, 'la etiqueta cuenta en la búsqueda por texto');
  r = buscar('cliente', 'asignar', path.join(BANCO, 'Cliente Uno', 'formatos'), 'Otro cliente'); comprobar(!!r.json, 'cliente por carpeta');
  r = buscar('buscar', '--cliente', 'Otro cliente'); comprobar(r.json && r.json.total === 3, 'la regla de cliente aplica a la carpeta', JSON.stringify(r.json && r.json.total));

  console.log('6. Mover la biblioteca');
  const NUEVO = path.join(TRABAJO, 'Disco nuevo', 'Material');
  fs.mkdirSync(path.dirname(NUEVO), { recursive: true });
  buscar('cerrar'); // en Windows no se puede renombrar una carpeta con archivos abiertos
  fs.renameSync(BANCO, NUEVO);
  r = buscar('biblioteca', 'mover', 'Prueba', NUEVO); comprobar(r.json && r.json.movida, 'biblioteca movida', r.salida);
  r = buscar('indexar'); comprobar(r.json && r.json.fotos + r.json.videos === total && r.json.ultimo.procesadas === 0, 'después de mover no reindexa nada', JSON.stringify(r.json && r.json.ultimo));
  r = buscar('buscar', '--etiqueta', 'aprobada'); comprobar(r.json && r.json.total === 2 && r.json.resultados[0].ruta.startsWith(NUEVO), 'las etiquetas siguen pegadas en la ruta nueva', JSON.stringify(r.json && r.json.resultados.map(x => x.ruta)));

  console.log('7. Acceso directo y un solo servidor');
  const escritorio = process.env.BUSCAR_ESCRITORIO || path.join(os.homedir(), 'Desktop');
  const acceso = WIN ? path.join(escritorio, 'Buscar material.cmd') : path.join(escritorio, 'Buscar material.app');
  comprobar(fs.existsSync(acceso), 'preparar dejó el acceso directo en el Escritorio', acceso);
  const antes = buscar('abrir').json;
  if (fs.existsSync(acceso)) {
    const a = WIN ? spawnSync(comillas(acceso), { shell: true, encoding: 'utf8', env: { ...process.env, BUSCAR_SIN_NAVEGADOR: '1' } })
      : spawnSync(path.join(acceso, 'Contents', 'MacOS', 'abrir'), [], { encoding: 'utf8', env: { ...process.env, BUSCAR_SIN_NAVEGADOR: '1' } });
    comprobar(a.status === 0, 'el acceso directo corre', (a.stdout || '') + (a.stderr || ''));
  }
  const despues = buscar('abrir').json;
  comprobar(antes && despues && antes.url === despues.url, 'abrir dos veces no levanta otro servidor', JSON.stringify([antes, despues]));
  R.url = despues && despues.url;
}

try { await principal(); } catch (e) { console.log('ERROR', e.message); R.fallas.push('excepción: ' + e.message.slice(0, 1500)); }
const tiempos = R.busquedas.map(b => b.msMotor).filter(x => x != null).sort((a, b) => a - b);
R.msPorBusquedaMediana = tiempos.length ? tiempos[tiempos.length >> 1] : null;
fs.writeFileSync(path.join(SALIDA, `resultados-${R.sistema}.json`), JSON.stringify(R, null, 1));
console.log(`\n${R.sistema}: ${R.pasos.imagenesPorSegundo} imágenes por segundo, ${R.msPorBusquedaMediana} ms por búsqueda, ${R.fallas.length} fallas`);
if (R.fallas.length) { console.log(R.fallas.join('\n')); process.exitCode = 1; }
