// Prueba de las etiquetas compartidas: dos compus (dos carpetas de datos distintas) con el mismo material en rutas
// distintas, y una carpeta compartida que viaja por git de verdad (un repositorio central y un clon por compu).
// No necesita el modelo ni las herramientas: arma un índice de mentira y habla con el buscador por sus comandos.
// Uso: node pruebas/compartidas.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = path.join(RAIZ, 'pruebas', 'salida');
const TRABAJO = path.join(os.tmpdir(), 'buscar compartidas ' + process.pid); // con espacio a propósito
fs.rmSync(TRABAJO, { recursive: true, force: true }); fs.mkdirSync(TRABAJO, { recursive: true }); fs.mkdirSync(SALIDA, { recursive: true });
const fallas = []; let hechas = 0;
function comprobar(cond, nombre, detalle = '') { hechas++; if (cond) console.log('  ok  ' + nombre); else { console.log('  FALLA  ' + nombre + ' ' + detalle); fallas.push(nombre + ' ' + detalle); } }
const dormir = ms => new Promise(r => setTimeout(r, ms));
const J = x => JSON.stringify(x);

// ---------- git: un repositorio central y un clon por compu, como la Mente compartida del equipo ----------
const HAY_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
function git(dir, ...a) {
  return spawnSync('git', ['-C', dir, '-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=true', ...a], { encoding: 'utf8', windowsHide: true });
}
const CENTRAL = path.join(TRABAJO, 'central.git');
const SUB = ['material', 'etiquetas']; // la carpeta compartida va dentro de la Mente, no en su raíz

// ---------- las dos compus ----------
const FOTOS = [['Cliente Uno', 'foto1.jpg'], ['Cliente Uno', 'foto2.jpg'], ['Cliente Dos', 'foto3.jpg'], ['Cliente Dos', 'foto4.jpg'], ['Cliente Dos', 'foto5.jpg']];
const huella = n => 'huella-de-foto' + n;
function registro(n) { const [dir, nombre] = FOTOS[n - 1]; return { id: n, lib: 'b1', rel: dir + '/' + nombre, tam: 1000 + n, mod: 1760000000000 + n * 1000, tipo: 'f', fecha: 1760000000000 + n * 1000, hr: huella(n), w: 1200, h: 800, v0: 0, vn: 0 }; }

function armarCompu(letra, carpetaMaterial, cuantas, puerto, uid) {
  const c = { letra, home: path.join(TRABAJO, 'datos de ' + letra), puerto, mente: path.join(TRABAJO, 'Mente de ' + letra) };
  fs.mkdirSync(path.join(c.home, 'datos'), { recursive: true });
  fs.mkdirSync(carpetaMaterial, { recursive: true });
  for (const [dir, nombre] of FOTOS) { fs.mkdirSync(path.join(carpetaMaterial, dir), { recursive: true }); fs.writeFileSync(path.join(carpetaMaterial, dir, nombre), 'no es una foto de verdad: ' + nombre); }
  c.material = fs.realpathSync(carpetaMaterial);
  fs.writeFileSync(path.join(c.home, 'datos', 'bibliotecas.json'), J([{ id: 'b1', nombre: 'Material ' + letra, ruta: c.material, alta: 1, ...(uid ? { uid } : {}) }]));
  fs.writeFileSync(path.join(c.home, 'datos', 'archivos.jsonl'), Array.from({ length: cuantas }, (_, i) => J(registro(i + 1))).join('\n') + '\n');
  c.compartida = path.join(c.mente, ...SUB);
  c.ruta = n => path.join(c.material, ...FOTOS[n - 1]);
  c.env = { ...process.env, BUSCAR_MATERIAL_HOME: c.home, BUSCAR_PUERTO: String(puerto), BUSCAR_SIN_REVISAR: '1', BUSCAR_SIN_NAVEGADOR: '1', BUSCAR_SIN_DIALOGO: '1' };
  return c;
}
async function encender(c) {
  const registroServidor = fs.openSync(path.join(c.home, 'servidor.log'), 'a');
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'motor', 'servidor.cjs')], { env: c.env, stdio: ['ignore', registroServidor, registroServidor], windowsHide: true });
  c.hijo = hijo; c.cerrado = new Promise(r => hijo.on('exit', r));
  for (let i = 0; i < 150; i++) {
    await dormir(200);
    let s = null; try { s = JSON.parse(fs.readFileSync(path.join(c.home, 'servidor.json'), 'utf8')); } catch {}
    if (s && s.pid === hijo.pid) { try { const r = await fetch(`http://127.0.0.1:${s.puerto}/api/vivo`); if (r.ok) { c.url = `http://127.0.0.1:${s.puerto}`; return; } } catch {} }
  }
  throw new Error('El buscador de la compu ' + c.letra + ' no arrancó:\n' + fs.readFileSync(path.join(c.home, 'servidor.log'), 'utf8').slice(-1500));
}
async function apagar(c) {
  if (!c.hijo) return;
  cmd(c, 'cerrar');
  await Promise.race([c.cerrado, dormir(8000)]);
  try { c.hijo.kill(); } catch {}
  c.hijo = null;
}
// Corre un comando del buscador en esa compu. Devuelve { json, codigo, salida }.
function cmd(c, ...args) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'buscar.cjs'), ...args], { env: c.env, encoding: 'utf8', maxBuffer: 32e6, windowsHide: true });
  const linea = (r.stdout || '').trim().split(/\r?\n/).filter(l => l.startsWith('{') || l.startsWith('[')).pop();
  let json = null; try { json = JSON.parse(linea); } catch {}
  return { json, codigo: r.status, salida: (r.stdout || '') + (r.stderr || '') };
}
function ok(c, ...args) { const r = cmd(c, ...args); if (r.codigo !== 0 || !r.json) throw new Error(`[${c.letra}] "${args.join(' ')}" salió con ${r.codigo}: ${r.salida.slice(-600)}`); return r.json; }
const foto = (c, n) => ok(c, 'buscar', FOTOS[n - 1][1]).resultados[0] || {};
const etiquetasDe = (c, n) => (foto(c, n).etiquetas || []).join(',');
const estado = c => ok(c, 'etiquetas', 'estado');
const eventosDe = c => { try { return fs.readdirSync(path.join(c.compartida, 'eventos')).filter(f => f.endsWith('.jsonl')); } catch { return []; } };

// Sube y baja la Mente de esa compu, como hace la app del equipo. Con git de verdad; si no hay git, copiando archivos.
let conflictos = 0, otra = null;
function sincronizar(c, modo = '--no-rebase') {
  if (!HAY_GIT) { // cada compu solo copia hacia la otra los archivos que la otra no escribe
    const de = path.join(c.compartida, 'eventos'), a = path.join(otra(c).compartida, 'eventos');
    fs.mkdirSync(de, { recursive: true }); fs.mkdirSync(a, { recursive: true });
    const propio = d => estadoArchivo[d.letra];
    for (const f of fs.readdirSync(de)) if (f.endsWith('.jsonl') && f !== propio(otra(c))) fs.copyFileSync(path.join(de, f), path.join(a, f));
    for (const f of fs.readdirSync(a)) if (f.endsWith('.jsonl') && f !== propio(c)) fs.copyFileSync(path.join(a, f), path.join(de, f));
    return;
  }
  git(c.mente, 'add', '-A');
  git(c.mente, 'commit', '-q', '-m', 'Compartir desde la compu ' + c.letra);
  const baja = git(c.mente, 'pull', '-q', modo, '--no-edit', 'origin', 'main');
  const sucio = git(c.mente, 'diff', '--name-only', '--diff-filter=U').stdout.trim();
  if (baja.status !== 0 || sucio) { conflictos++; console.log('  git no pudo bajar en ' + c.letra + ':', baja.stdout, baja.stderr, sucio); }
  const sube = git(c.mente, 'push', '-q', 'origin', 'HEAD:main');
  if (sube.status !== 0) { conflictos++; console.log('  git no pudo subir en ' + c.letra + ':', sube.stderr); }
}
const estadoArchivo = {};
async function renombrar(de, a) { // en Windows puede fallar un instante si algo todavía tiene abierta la carpeta
  for (let i = 0; ; i++) { try { fs.renameSync(de, a); return; } catch (e) { if (i > 40) throw e; await dormir(250); } }
}

async function principal() {
  const A = armarCompu('A', path.join(TRABAJO, 'Disco de A', 'Material'), 5, 4611);
  const B = armarCompu('B', path.join(TRABAJO, 'Otra ruta', 'Drive', 'Material del equipo'), 4, 4631, 'L-vieja001'); // B todavía no indexó la foto 5
  otra = c => (c === A ? B : A);
  const ambas = () => { sincronizar(A); sincronizar(B, '--rebase'); sincronizar(A); };

  if (HAY_GIT) {
    console.log('0. Repositorio central y un clon por compu');
    spawnSync('git', ['init', '-q', '--bare', '--initial-branch=main', CENTRAL], { encoding: 'utf8' });
    fs.mkdirSync(A.mente, { recursive: true });
    spawnSync('git', ['init', '-q', '--initial-branch=main', A.mente], { encoding: 'utf8' });
    git(A.mente, 'remote', 'add', 'origin', CENTRAL);
    fs.writeFileSync(path.join(A.mente, 'LEEME.md'), 'Mente del equipo (prueba)\n');
    git(A.mente, 'add', '-A'); git(A.mente, 'commit', '-q', '-m', 'Inicio');
    const p = git(A.mente, 'push', '-q', '-u', 'origin', 'main');
    const k = spawnSync('git', ['clone', '-q', CENTRAL, B.mente], { encoding: 'utf8' });
    comprobar(p.status === 0 && k.status === 0, 'la Mente se clona en las dos compus', p.stderr + k.stderr);
  } else { console.log('0. Sin git en esta compu: la sincronización se simula copiando archivos'); fs.mkdirSync(A.mente, { recursive: true }); fs.mkdirSync(B.mente, { recursive: true }); }

  // B viene de la versión anterior: tiene etiquetas, una marca de usada y una regla de cliente en el formato viejo
  const viejoB = path.join(B.home, 'etiquetas');
  fs.mkdirSync(viejoB, { recursive: true });
  const textoViejo = [
    J({ h: huella(2), e: ['borrador', 'del año pasado'], u: { f: '2026-10-01', n: 'Historia de octubre' }, q: ['descartada'], n: 'foto2.jpg', m: 1761000000000 }),
    J({ h: huella(4), e: ['borrador'], n: 'foto4.jpg', m: 1761000000500 }),
    '<<<<<<< una marca de conflicto que quedó de antes',
    J({ h: 'huella-de-una-foto-que-nadie-tiene', e: ['perdida'], m: 1761000001000 }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(viejoB, 'etiquetas.jsonl'), textoViejo);
  const clientesViejo = J({ lib: 'L-vieja001', nombre: 'Material B', carpetas: ['Cliente Dos', 'Cliente Uno'], m: 1761000000000 }) + '\n' + J({ lib: 'L-vieja001', c: 'Cliente Dos', cliente: 'Dos y Compañía', m: 1761000000000 }) + '\n';
  fs.writeFileSync(path.join(viejoB, 'clientes.jsonl'), clientesViejo);

  await encender(A); await encender(B);

  console.log('1. Sin carpeta compartida todo funciona en local, como antes');
  let e = estado(A);
  comprobar(e.compartida === false && typeof e.autor === 'string' && e.autor.length > 0, 'por defecto no comparte y el autor es el usuario del sistema', J(e));
  ok(A, 'etiquetas', 'autor', 'Ana');
  let r = ok(A, 'etiquetar', A.ruta(1), A.ruta(2), '--agregar', 'Carta Verano,aprobada');
  comprobar(r.etiquetadas === 2, 'A etiqueta dos fotos', J(r));
  r = ok(A, 'marcar-usada', A.ruta(1), '--nota', 'Instagram 12/11');
  comprobar(r.marcadas === 1, 'A marca una como usada');
  r = ok(A, 'buscar', '--etiqueta', 'carta verano', '--sin-usar');
  comprobar(r.total === 1 && r.resultados[0].ruta === A.ruta(2), 'A filtra por etiqueta y sin usar', J(r));
  comprobar(foto(A, 1).usadaPor === 'Ana' && /Instagram 12\/11/.test(foto(A, 1).usada), 'la marca de usada guarda quién y la nota', J(foto(A, 1)));
  comprobar(etiquetasDe(B, 1) === '' && !fs.existsSync(B.compartida), 'B no se entera de nada: no hay nada compartido');
  comprobar(fs.existsSync(path.join(A.home, 'etiquetas', 'eventos')) && !fs.existsSync(A.compartida), 'lo de A quedó en su carpeta de datos');

  console.log('2. Migración desde los datos de la versión anterior');
  comprobar(etiquetasDe(B, 2) === 'borrador,del año pasado' && etiquetasDe(B, 4) === 'borrador', 'B conserva sus etiquetas viejas', etiquetasDe(B, 2));
  comprobar(foto(B, 2).usada === '2026-10-01 · Historia de octubre', 'B conserva la marca de usada con su fecha y su nota', J(foto(B, 2)));
  r = ok(B, 'buscar', '--cliente', 'Dos y Compañía');
  comprobar(r.total === 2, 'B conserva la regla de cliente por carpeta', J(r.total));
  comprobar(fs.readFileSync(path.join(viejoB, 'etiquetas.jsonl'), 'utf8') === textoViejo && fs.readFileSync(path.join(viejoB, 'clientes.jsonl'), 'utf8') === clientesViejo, 'los archivos viejos no se tocan');
  const antes = estado(B).eventos;
  await apagar(B); await encender(B);
  comprobar(estado(B).eventos === antes && antes > 0 && etiquetasDe(B, 2) === 'borrador,del año pasado', 'migrar de nuevo (otro arranque) no duplica nada', J([antes, estado(B).eventos]));
  ok(B, 'etiquetar', B.ruta(2), '--quitar', 'borrador');
  await apagar(B); await encender(B);
  comprobar(etiquetasDe(B, 2) === 'del año pasado', 'una etiqueta vieja quitada después no revive al reiniciar', etiquetasDe(B, 2));

  console.log('3. Compartir: cada compu apunta a la carpeta dentro de su clon de la Mente');
  r = ok(A, 'etiquetas', 'compartir', A.compartida);
  comprobar(r.compartida === true && r.autor === 'Ana', 'A comparte', J(r));
  r = ok(B, 'etiquetas', 'compartir', B.compartida, '--autor', 'Beto');
  comprobar(r.compartida === true && r.autor === 'Beto', 'B comparte y elige su nombre', J(r));
  estadoArchivo.A = path.basename(estado(A).archivoPropio); estadoArchivo.B = path.basename(estado(B).archivoPropio);
  comprobar(estadoArchivo.A !== estadoArchivo.B && eventosDe(A).join() === estadoArchivo.A && eventosDe(B).join() === estadoArchivo.B, 'cada compu escribe solo su archivo', J([eventosDe(A), eventosDe(B)]));
  ambas();
  comprobar(etiquetasDe(B, 1) === 'aprobada,carta verano', 'B ve las etiquetas de A', etiquetasDe(B, 1));
  comprobar(foto(B, 1).ruta === B.ruta(1), 'B las ve en su propia ruta', J([foto(B, 1).ruta, B.ruta(1)]));
  comprobar(foto(B, 1).usadaPor === 'Ana' && /Instagram 12\/11/.test(foto(B, 1).usada), 'B ve que la usó Ana, con la nota', J(foto(B, 1)));
  comprobar(etiquetasDe(A, 2) === 'aprobada,carta verano,del año pasado' && foto(A, 2).usada === '2026-10-01 · Historia de octubre', 'A ve lo que B traía de la versión anterior, unido con lo suyo', J(foto(A, 2)));
  r = ok(B, 'buscar', '--etiqueta', 'carta verano', '--sin-usar');
  comprobar(r.total === 0, 'B filtra "sin usar" con lo que marcaron entre las dos (la foto 2 ya la había usado B)', J(r));
  comprobar(ok(A, 'buscar', '--cliente', 'Dos y Compañía').total === 3, 'A recibe la regla de cliente de B aunque cada una registró la biblioteca por su lado', J(ok(A, 'estado').clientes));

  console.log('4. Las dos editan la misma foto a la vez');
  ok(A, 'etiquetar', A.ruta(3), '--agregar', 'vertical');
  ok(B, 'etiquetar', B.ruta(3), '--agregar', 'para historias');
  ok(A, 'marcar-usada', A.ruta(3), '--nota', 'Instagram');
  await dormir(15);
  ok(B, 'marcar-usada', B.ruta(3), '--nota', 'Web');
  if (HAY_GIT) { // la Mente de B baja lo de A mientras B todavía tiene cambios sin subir
    sincronizar(A);
    const baja = git(B.mente, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
    comprobar(baja.status === 0 && etiquetasDe(B, 3) === 'para historias,vertical', 'bajar lo de la otra con cambios propios sin subir no choca', baja.stderr);
  }
  ambas();
  comprobar(etiquetasDe(A, 3) === 'para historias,vertical' && etiquetasDe(B, 3) === 'para historias,vertical', 'quedan las etiquetas de las dos', etiquetasDe(A, 3) + ' | ' + etiquetasDe(B, 3));
  comprobar(J(foto(A, 3).usada) === J(foto(B, 3).usada) && foto(A, 3).usadaPor === foto(B, 3).usadaPor && /Web/.test(foto(A, 3).usada) && foto(A, 3).usadaPor === 'Beto', 'las dos compus muestran la misma marca de usada: la última', J([foto(A, 3), foto(B, 3)]));

  e = estado(A);
  comprobar(e.personas.some(p => p.nombre === 'Ana') && e.personas.some(p => p.nombre === 'Beto') && e.ultimaNovedadDeOtraCompu, 'el estado dice quiénes escribieron y cuándo llegó lo último', J(e.personas));

  console.log('5. Quitar le gana a un agregado anterior, y se puede volver a agregar');
  ok(B, 'etiquetar', B.ruta(1), '--quitar', 'aprobada');
  ambas();
  comprobar(etiquetasDe(A, 1) === 'carta verano' && etiquetasDe(B, 1) === 'carta verano', 'lo que quita B desaparece en A', etiquetasDe(A, 1));
  ok(A, 'etiquetar', A.ruta(1), '--agregar', 'aprobada');
  ambas();
  comprobar(etiquetasDe(B, 1) === 'aprobada,carta verano', 'si A la vuelve a poner, vuelve en B', etiquetasDe(B, 1));
  ok(B, 'marcar-usada', B.ruta(1), '--deshacer');
  ambas();
  comprobar(!foto(A, 1).usada && !foto(B, 1).usada, 'quitar la marca de usada en B se refleja en A', J(foto(A, 1)));
  ok(B, 'marcar-usada', B.ruta(2), '--nota', 'Historia de octubre, repetida en noviembre');
  comprobar(foto(B, 2).usada === '2026-10-01 · Historia de octubre, repetida en noviembre', 'cambiar la nota conserva la fecha original', J(foto(B, 2)));

  console.log('6. Relojes desfasados y empates');
  const tercera = path.join(A.compartida, 'eventos', 'tercera-compu.jsonl');
  const futuro = Date.now() + 400 * 86400000;
  fs.writeFileSync(tercera, [
    J({ id: 'reloj-adelantado', ts: futuro, por: 'Caro', tipo: 'etiquetas', h: huella(4), mas: ['del futuro'] }),
    J({ id: 'reloj-atrasado', ts: 1000, por: 'Caro', tipo: 'etiquetas', h: huella(1), menos: ['carta verano'] }),
    J({ id: 'empate-b-agrega', ts: 1762000000000, por: 'Caro', tipo: 'etiquetas', h: huella(4), mas: ['empate'] }),
    J({ id: 'empate-a-quita', ts: 1762000000000, por: 'Caro', tipo: 'etiquetas', h: huella(4), menos: ['empate'] }),
    J({ id: 'empate-z-agrega', ts: 1762000000000, por: 'Caro', tipo: 'etiquetas', h: huella(4), mas: ['empate'] }),
  ].join('\n') + '\n');
  ambas();
  comprobar(etiquetasDe(A, 4) === 'borrador,del futuro' && etiquetasDe(B, 4) === 'borrador,del futuro', 'a igual marca de tiempo gana quitar, en las dos compus', etiquetasDe(A, 4) + ' | ' + etiquetasDe(B, 4));
  comprobar(etiquetasDe(A, 1) === 'aprobada,carta verano', 'un "quitar" con fecha vieja no borra un agregado posterior', etiquetasDe(A, 1));
  ok(B, 'etiquetar', B.ruta(4), '--quitar', 'del futuro'); // el reloj de B "atrasa" más de un año respecto de ese evento
  ambas();
  comprobar(etiquetasDe(A, 4) === 'borrador' && etiquetasDe(B, 4) === 'borrador', 'quitar algo que se ve en pantalla funciona aunque el otro reloj esté adelantado', etiquetasDe(A, 4));
  ok(A, 'etiquetar', A.ruta(4), '--agregar', 'del futuro');
  ambas();
  comprobar(etiquetasDe(B, 4) === 'borrador,del futuro', 'y volver a ponerla también', etiquetasDe(B, 4));

  console.log('7. Líneas rotas o cortadas no rompen nada');
  fs.writeFileSync(path.join(A.compartida, 'eventos', 'rota-compu.jsonl'), Buffer.concat([
    Buffer.from('﻿' + J({ id: 'buena-1', ts: Date.now(), por: 'Dani', tipo: 'etiquetas', h: huella(2), mas: ['sobrevive'] }) + '\r\n'),
    Buffer.from('esto no es json\n\n   \n<<<<<<< HEAD\n=======\n>>>>>>> otra\n[1,2,3]\nnull\n42\n"texto"\n{"id":"sin-fecha","tipo":"etiquetas"}\n{"id":7,"ts":5,"tipo":"etiquetas"}\n'),
    Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]),
    Buffer.from(J({ id: 'tipo-nuevo', ts: Date.now(), por: 'Dani', tipo: 'algo-de-una-version-futura', dato: 1 }) + '\n'),
    Buffer.from(J({ id: 'rara', ts: Date.now(), por: 'Dani', tipo: 'etiquetas', h: huella(2), mas: 'no es una lista', menos: [null, 5, {}] }) + '\n'),
    Buffer.from(J({ id: 'buena-2', ts: Date.now(), por: 'Dani', tipo: 'usada', h: huella(4), f: 'fecha rara', nota: 'Folleto' }) + '\n'),
    Buffer.from('{"id":"cortada","ts":17620000'), // la última línea quedó a medio escribir
  ]));
  fs.writeFileSync(path.join(A.compartida, 'eventos', 'vacia-compu.jsonl'), '');
  const propioA = path.join(A.compartida, 'eventos', estadoArchivo.A);
  fs.appendFileSync(propioA, '{"id":"cortada-propia","ts":1762'); // el archivo de A también quedó con la última línea cortada
  ambas();
  e = estado(A);
  comprobar(etiquetasDe(A, 2).includes('sobrevive') && etiquetasDe(B, 2).includes('sobrevive'), 'los eventos sanos de un archivo con basura se leen igual', etiquetasDe(A, 2));
  comprobar(/Folleto/.test(foto(B, 4).usada) && /^\d{4}-\d\d-\d\d/.test(foto(B, 4).usada), 'una fecha inválida se reemplaza por la del evento', J(foto(B, 4)));
  comprobar(e.lineasIlegibles >= 8, 'el estado cuenta las líneas que no pudo leer', J(e.lineasIlegibles));
  ok(A, 'etiquetar', A.ruta(5), '--agregar', 'después de la cortada');
  ambas();
  comprobar(etiquetasDe(A, 5) === 'después de la cortada', 'A sigue escribiendo bien después de su línea cortada', etiquetasDe(A, 5));
  comprobar(ok(A, 'estado').fotos === 5 && ok(B, 'estado').fotos === 4, 'los dos buscadores siguen andando');

  console.log('8. Etiquetas de una foto que esta compu todavía no indexó');
  comprobar(estado(B).deFotosQueEstaCompuNoTiene >= 1, 'B guarda la etiqueta de la foto 5 aunque no la tiene', J(estado(B).deFotosQueEstaCompuNoTiene));
  await apagar(B);
  fs.appendFileSync(path.join(B.home, 'datos', 'archivos.jsonl'), J(registro(5)) + '\n'); // B la indexa
  await encender(B);
  comprobar(etiquetasDe(B, 5) === 'después de la cortada', 'al indexarla, aparece con la etiqueta que le puso A', etiquetasDe(B, 5));

  console.log('9. Lista acordada de etiquetas');
  r = ok(A, 'etiquetas', 'lista', 'agregar', 'Aprobada, carta verano');
  comprobar(J(r.lista) === J(['aprobada', 'carta verano']), 'A arma la lista', J(r));
  r = ok(B, 'etiquetas', 'lista', 'agregar', 'vertical', 'pendiente de aprobación');
  ambas();
  const listaA = ok(A, 'etiquetas', 'lista', 'ver'), listaB = ok(B, 'etiquetas', 'lista');
  comprobar(J(listaA) === J(listaB) && J(listaA.lista.map(x => x.nombre)) === J(['aprobada', 'carta verano', 'pendiente de aprobación', 'vertical']), 'las dos ven la misma lista, con lo que sumó cada una', J(listaA.lista));
  comprobar(listaA.lista.find(x => x.nombre === 'pendiente de aprobación').fotos === 0 && listaA.sueltas.some(x => x.nombre === 'borrador') && !listaA.sueltas.some(x => x.nombre === 'vertical'), 'distingue las de la lista de las sueltas y no prohíbe ninguna', J(listaA));
  ok(B, 'etiquetas', 'lista', 'quitar', 'vertical');
  ambas();
  comprobar(!ok(A, 'etiquetas', 'lista').lista.some(x => x.nombre === 'vertical') && etiquetasDe(A, 3).includes('vertical'), 'sacar una etiqueta de la lista no la saca de las fotos', J(ok(A, 'etiquetas', 'lista')));

  console.log('10. Cliente por carpeta entre compus');
  ok(A, 'cliente', 'asignar', path.join(A.material, 'Cliente Uno'), 'Uno SRL');
  ok(B, 'cliente', 'asignar', path.join(B.material, 'Cliente Dos'), 'Dos SA'); // pisa la regla vieja de B
  ambas();
  comprobar(ok(B, 'buscar', '--cliente', 'Uno SRL').total === 2 && ok(A, 'buscar', '--cliente', 'Dos SA').total === 3 && ok(A, 'buscar', '--cliente', 'Dos y Compañía').total === 0, 'las reglas de cliente viajan en los dos sentidos', J([ok(A, 'estado').clientes, ok(B, 'estado').clientes]));

  console.log('11. Nada raro en la carpeta ni en git');
  comprobar(conflictos === 0, 'git nunca marcó un conflicto ni rechazó una subida', String(conflictos));
  const enCarpeta = fs.readdirSync(path.join(A.compartida, 'eventos'));
  comprobar(!enCarpeta.some(f => f.includes('.tmp')), 'no quedan archivos temporales', enCarpeta.join());
  if (HAY_GIT) {
    const limpio = git(A.mente, 'status', '--porcelain').stdout.trim();
    comprobar(limpio === '', 'después de sincronizar, la Mente de A queda sin cambios pendientes', limpio);
    const autores = git(A.mente, 'log', '--format=%s', '--', [...SUB, 'eventos', estadoArchivo.B].join('/')).stdout.trim().split('\n');
    comprobar(autores.every(s => s.endsWith('B')), 'el archivo de B solo lo cambian commits de B', autores.join(' | '));
  }
  comprobar(J(etiquetasDe(A, 2)) === J(etiquetasDe(B, 2)) && estado(A).eventos === estado(B).eventos, 'las dos compus terminan con el mismo estado', J([estado(A).eventos, estado(B).eventos]));

  console.log('12. Carpeta compartida que desaparece, y dejar de compartir');
  const escondida = A.mente + ' (movida)';
  await apagar(A); // en Windows no se puede renombrar la carpeta mientras git o el buscador la miran
  await renombrar(A.mente, escondida);
  await encender(A);
  r = cmd(A, 'etiquetar', A.ruta(1), '--agregar', 'no debería guardarse');
  comprobar(r.codigo !== 0 && /No encuentro la carpeta compartida/.test(r.salida) && !fs.existsSync(A.mente), 'si la carpeta no está, avisa y no la inventa', r.salida.slice(0, 200));
  comprobar(estado(A).noEncuentroLaCarpeta === true, 'el estado lo informa');
  await renombrar(escondida, A.mente);
  comprobar(etiquetasDe(A, 1) === 'aprobada,carta verano' && !estado(A).noEncuentroLaCarpeta, 'cuando vuelve, todo sigue ahí', etiquetasDe(A, 1));
  r = ok(B, 'etiquetas', 'compartir', '--dejar');
  comprobar(r.compartida === false && etiquetasDe(B, 1) === 'aprobada,carta verano' && foto(B, 3).usadaPor === 'Beto', 'B deja de compartir y se queda con todo lo que había', J(r));
  ok(A, 'etiquetar', A.ruta(1), '--agregar', 'solo de a');
  ambas();
  comprobar(!etiquetasDe(B, 1).includes('solo de a') && etiquetasDe(A, 1).includes('solo de a'), 'desde ahí los cambios de A ya no le llegan');
  r = ok(B, 'etiquetas', 'compartir', B.compartida);
  comprobar(etiquetasDe(B, 1).includes('solo de a'), 'y al volver a compartir se pone al día', etiquetasDe(B, 1));

  await apagar(A); await apagar(B);

  console.log('13. Un equipo que ya compartía la carpeta con el formato anterior');
  // Dos compus que venían de la 3.0: su configuración ya apunta a una carpeta de la Mente con etiquetas.jsonl y clientes.jsonl
  const VIEJA = ['material', 'etiquetas de antes'];
  const C = armarCompu('C', A.material, 5, 4651, 'L-equipo01'), D = armarCompu('D', B.material, 5, 4671, 'L-equipo01');
  C.mente = A.mente; D.mente = B.mente; C.compartida = path.join(C.mente, ...VIEJA); D.compartida = path.join(D.mente, ...VIEJA);
  otra = c => (c === C ? D : C);
  const compartidoViejo = J({ h: huella(1), e: ['del equipo'], u: { f: '2026-09-15', n: 'Carrusel' }, n: 'foto1.jpg', m: 1760500000000 }) + '\n' + J({ h: huella(3), e: ['del equipo', 'vieja'], q: ['quitada'], n: 'foto3.jpg', m: 1760500000001 }) + '\n';
  const clientesCompartido = J({ lib: 'L-equipo01', nombre: 'Material', carpetas: ['Cliente Dos', 'Cliente Uno'], m: 1760500000000 }) + '\n' + J({ lib: 'L-equipo01', c: 'Cliente Uno', cliente: 'Uno del equipo', m: 1760500000000 }) + '\n';
  for (const c of [C, D]) {
    fs.mkdirSync(c.compartida, { recursive: true });
    fs.writeFileSync(path.join(c.compartida, 'etiquetas.jsonl'), compartidoViejo);
    fs.writeFileSync(path.join(c.compartida, 'clientes.jsonl'), clientesCompartido);
    fs.writeFileSync(path.join(c.compartida, '.gitattributes'), 'etiquetas.jsonl merge=union\nclientes.jsonl merge=union\n');
    fs.writeFileSync(path.join(c.home, 'config.json'), J({ etiquetas: c.compartida }));
  }
  const cyd = () => { sincronizar(C); sincronizar(D, '--rebase'); sincronizar(C); };
  cyd(); // la carpeta vieja ya estaba subida y es igual en las dos
  await encender(C); await encender(D);
  e = estado(C);
  comprobar(e.compartida === true && estado(D).compartida === true, 'después de actualizar siguen compartiendo, sin configurar nada', J(e.carpeta));
  comprobar(etiquetasDe(C, 3) === 'del equipo,vieja' && etiquetasDe(D, 3) === 'del equipo,vieja' && foto(D, 1).usada === '2026-09-15 · Carrusel', 'las dos conservan lo que había en el archivo compartido', J([foto(C, 3), foto(D, 1)]));
  comprobar(ok(C, 'buscar', '--cliente', 'Uno del equipo').total === 2 && ok(D, 'buscar', '--cliente', 'Uno del equipo').total === 2, 'y las reglas de cliente compartidas');
  estadoArchivo.C = path.basename(estado(C).archivoPropio); estadoArchivo.D = path.basename(estado(D).archivoPropio);
  ok(D, 'etiquetar', D.ruta(3), '--quitar', 'vieja');
  ok(C, 'etiquetar', C.ruta(3), '--agregar', 'nueva');
  const conflictosAntes = conflictos;
  cyd();
  comprobar(conflictos === conflictosAntes, 'las dos migraron el mismo archivo por su lado y git no marca conflicto');
  comprobar(etiquetasDe(C, 3) === 'del equipo,nueva' && etiquetasDe(D, 3) === 'del equipo,nueva', 'lo migrado dos veces cuenta una sola: lo que quita una no lo revive la otra', etiquetasDe(C, 3) + ' | ' + etiquetasDe(D, 3));
  comprobar(estado(C).eventos === estado(D).eventos, 'las dos cuentan los mismos cambios', J([estado(C).eventos, estado(D).eventos]));
  comprobar(fs.readFileSync(path.join(C.compartida, 'etiquetas.jsonl'), 'utf8').replace(/\r/g, '') === compartidoViejo, 'el archivo viejo compartido queda como estaba');
  await apagar(C); await apagar(D);
}

try { await principal(); } catch (e) { console.log('ERROR', e.stack || e.message); fallas.push('excepción: ' + String(e.message).slice(0, 1500)); }
// por si quedó algún buscador de la prueba abierto
for (const d of fs.readdirSync(TRABAJO)) { try { const s = JSON.parse(fs.readFileSync(path.join(TRABAJO, d, 'servidor.json'), 'utf8')); process.kill(s.pid); } catch {} }
const sistema = `${process.platform}-${process.arch}`;
fs.writeFileSync(path.join(SALIDA, `compartidas-${sistema}.json`), JSON.stringify({ sistema, node: process.version, git: HAY_GIT, comprobaciones: hechas, fallas }, null, 1));
try { fs.rmSync(TRABAJO, { recursive: true, force: true }); } catch {}
console.log(`\n${sistema}: ${hechas} comprobaciones, ${fallas.length} fallas` + (HAY_GIT ? '' : ' (sin git: sincronización simulada)'));
if (fallas.length) { console.log(fallas.join('\n')); process.exitCode = 1; }
