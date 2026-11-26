// Recorre las bibliotecas y mantiene el índice al día. Incremental y reanudable: compara ruta + tamaño + fecha.
const path = require('path');
const fs = require('fs');
const indice = require('./indice.cjs');
const medios = require('./medios.cjs');
const modelo = require('./modelo.cjs');
const bibliotecas = require('./bibliotecas.cjs');

const SALTEAR = new Set(['node_modules', '__macosx', '$recycle.bin', 'system volume information', 'cache', 'caches', 'tmp', 'temp', 'thumbs', 'thumbnails', '.thumbnails', 'lost+found', 'recycler', 'adobe premiere pro auto-save', 'adobe premiere pro video previews', 'adobe premiere pro audio previews', 'render files', 'proxies']);
const SALTEAR_SUFIJO = ['.photoslibrary', '.lrdata', '.app', '.fcpbundle', '.imovielibrary', '.tmp'];
const LOTE = 16; // medido: lotes de 16 rinden un poco más que de 8; el cuello es el modelo, no la lectura de fotos

const estado = {
  activo: false, fase: '', biblioteca: '', total: 0, hechas: 0, porSeg: 0, falta: 0, inicio: 0,
  cancelar: false, ultimo: null, aviso: '',
};
let alCambiar = () => {};

function saltearCarpeta(nombre) {
  const n = nombre.toLowerCase();
  return n.startsWith('.') || n.startsWith('~') || SALTEAR.has(n) || SALTEAR_SUFIJO.some(s => n.endsWith(s));
}

// Lista { rel, tam, mod, tipo } de todo lo indexable dentro de una carpeta raíz. No sigue enlaces simbólicos.
async function recorrer(raiz) {
  const hallados = [];
  const pila = [''];
  let pasos = 0;
  while (pila.length) {
    const rel = pila.pop();
    let entradas;
    try { entradas = await fs.promises.readdir(path.join(raiz, ...rel.split('/').filter(Boolean)), { withFileTypes: true }); }
    catch (e) { if (rel === '') throw e; continue; } // carpeta sin permiso: se saltea
    for (const e of entradas) {
      if (e.isSymbolicLink()) continue;
      const hijo = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!saltearCarpeta(e.name)) pila.push(hijo); continue; }
      if (!e.isFile() || e.name.startsWith('.') || e.name.startsWith('~')) continue;
      const tipo = medios.tipoDe(e.name);
      if (!tipo) continue;
      try {
        const st = await fs.promises.stat(path.join(raiz, ...hijo.split('/')));
        if (st.size > 0) hallados.push({ rel: hijo.normalize('NFC'), relDisco: hijo, tam: st.size, mod: Math.round(st.mtimeMs), tipo });
      } catch {}
    }
    if (++pasos % 50 === 0) await new Promise(r => setImmediate(r));
    if (estado.cancelar) break;
  }
  return hallados;
}

async function prepararFoto(t) {
  try {
    const d = await medios.procesarFoto(t.abs);
    return d;
  } catch (e) { return { error: motivo(e) }; }
}

// Los motivos propios ya están en español; lo que venga de una biblioteca se resume.
function motivo(e) {
  const m = String((e && e.message) || e).split('\n')[0].slice(0, 160);
  return /[áéíóúñ]|RAW|PSD|ffmpeg|Formato/.test(m) ? m : 'No se pudo leer el archivo (puede estar dañado o incompleto)';
}

function registroBase(t) {
  const previo = indice.porClave.get(indice.clave(t.lib, t.rel));
  return { id: previo || indice.nuevoId(), lib: t.lib, rel: t.rel, tam: t.tam, mod: t.mod, tipo: t.tipo, fecha: t.mod };
}

async function indexarFotos(lote, preparadas) {
  const buenas = [];
  preparadas.forEach((p, i) => { if (!p.error) buenas.push(i); });
  let vecs = [];
  if (buenas.length) {
    try { vecs = await modelo.vectoresDeImagenes(buenas.map(i => preparadas[i].tensor)); }
    catch (e) { for (const i of buenas) preparadas[i] = { error: 'El modelo no pudo leer la imagen' }; buenas.length = 0; }
  }
  for (let i = 0; i < lote.length; i++) {
    const t = lote[i], p = preparadas[i], reg = registroBase(t);
    // la huella de contenido va siempre, aunque no haya miniatura: es lo que une el archivo con sus etiquetas
    try { reg.hr = await medios.hashRapido(t.abs, t.tam); } catch {}
    if (p.error) { reg.err = p.error; indice.guardar(reg, []); continue; }
    Object.assign(reg, { w: p.w, h: p.h, dh: p.dh });
    if (p.bc) reg.bc = p.bc;
    if (p.fecha) reg.fecha = p.fecha;
    await medios.guardarMini(reg.id, null, p.mini);
    indice.guardar(reg, [vecs[buenas.indexOf(i)]]);
  }
}

async function indexarVideo(t) {
  const reg = registroBase(t);
  let v = null;
  try { reg.hr = await medios.hashRapido(t.abs, t.tam); } catch {}
  try {
    v = await medios.cuadrosDeVideo(t.abs);
    if (!v) { reg.sinCuadros = 1; indice.guardar(reg, []); return; } // sin ffmpeg: queda buscable por nombre y carpeta
    Object.assign(reg, { w: v.w, h: v.h, dur: Math.round(v.dur * 10) / 10, ts: [] });
    const vecs = [];
    for (let i = 0; i < v.cuadros.length; i += LOTE) {
      const parte = v.cuadros.slice(i, i + LOTE);
      const prep = await Promise.all(parte.map(c => medios.derivar(medios.sharp()(c.archivo), true)));
      const vv = await modelo.vectoresDeImagenes(prep.map(p => p.tensor));
      for (let k = 0; k < parte.length; k++) {
        await medios.guardarMini(reg.id, parte[k].t, prep[k].mini);
        reg.ts.push(parte[k].t); vecs.push(vv[k]);
        if (i + k === Math.floor(v.cuadros.length / 3)) { await medios.guardarMini(reg.id, null, prep[k].mini); reg.dh = prep[k].dh; if (prep[k].bc) reg.bc = prep[k].bc; }
      }
      if (estado.cancelar) break;
    }
    if (!estado.cancelar) indice.guardar(reg, vecs);
  } catch (e) {
    reg.err = motivo(e);
    delete reg.ts;
    indice.guardar(reg, []);
  } finally { if (v) v.limpiar(); }
}

// Índices hechos con una versión anterior: el color de borde sale de la miniatura guardada y la huella, del original si está a mano.
// No pasa por el modelo, así que es rápido y no hace falta volver a indexar.
async function completar() {
  const faltan = [...indice.archivos.values()].filter(r => (!r.bc && !r.err && !r.sinCuadros && r.vn) || !r.hr);
  if (!faltan.length) return;
  estado.fase = 'completando'; alCambiar();
  let n = 0;
  for (const r of faltan) {
    if (estado.cancelar) break;
    let cambio = false;
    if (!r.bc && r.vn) { try { const c = await medios.colorDeMini(medios.rutaMini(r.id)); if (c) { r.bc = c; cambio = true; } } catch { r.bc = [0, 0, 0, 0]; } }
    if (!r.hr) { const b = bibliotecas.porId(r.lib); if (b && bibliotecas.conectada(b)) { try { r.hr = await medios.hashRapido(bibliotecas.rutaAbsoluta(b, r.rel), r.tam); cambio = true; } catch {} } }
    if (cambio) indice.reescribir(r);
    if (++n % 200 === 0) await new Promise(x => setImmediate(x));
  }
}

function medir() {
  const seg = (Date.now() - estado.inicioProceso) / 1000;
  if (seg > 1 && estado.hechas > 0) {
    estado.porSeg = Math.round(estado.hechas / seg * 10) / 10;
    estado.falta = Math.round((estado.total - estado.hechas) / (estado.hechas / seg));
  }
  alCambiar();
}

// opciones.reintentar: vuelve a probar los archivos que fallaron y los videos que quedaron sin cuadros
async function indexar(opciones = {}) {
  if (estado.activo) { estado.otraVez = { reintentar: !!opciones.reintentar || !!(estado.otraVez && estado.otraVez.reintentar) }; return estado; } // llegó un pedido en el medio: se hace otra pasada al terminar
  Object.assign(estado, { activo: true, fase: 'revisando', biblioteca: '', total: 0, hechas: 0, porSeg: 0, falta: 0, inicio: Date.now(), cancelar: false, aviso: '' });
  const resumen = { nuevas: 0, modificadas: 0, borradas: 0, errores: 0, desconectadas: [], segundos: 0 };
  alCambiar();
  try {
    const cola = [];
    const hayFfmpeg = !!medios.buscarFfmpeg();
    for (const b of bibliotecas.todas()) {
      if (opciones.biblioteca && opciones.biblioteca !== b.id) continue;
      estado.biblioteca = b.nombre; alCambiar();
      let hallados;
      try { if (!fs.statSync(b.ruta).isDirectory()) throw 0; hallados = await recorrer(b.ruta); }
      catch { resumen.desconectadas.push(b.nombre); continue; }
      if (estado.cancelar) break;
      const actuales = [...indice.archivos.values()].filter(r => r.lib === b.id);
      if (!hallados.length && actuales.length) { // carpeta vacía donde antes había material: probablemente el disco no montó bien
        estado.aviso = `"${b.nombre}" apareció vacía; no se quitó nada del índice.`;
        resumen.desconectadas.push(b.nombre); continue;
      }
      const vistos = new Set();
      for (const h of hallados) {
        vistos.add(h.rel);
        const id = indice.porClave.get(indice.clave(b.id, h.rel));
        const r = id && indice.archivos.get(id);
        const igual = r && r.tam === h.tam && r.mod === h.mod;
        const reintento = igual && (opciones.reintentar ? (r.err || r.sinCuadros) : (r.sinCuadros && hayFfmpeg));
        if (igual && !reintento) continue;
        if (r && !igual) resumen.modificadas++; else if (!r) resumen.nuevas++;
        cola.push({ ...h, lib: b.id, abs: path.join(b.ruta, ...h.relDisco.split('/')) });
      }
      for (const r of actuales) if (!vistos.has(r.rel)) { medios.borrarMinis(r.id, r.ts); indice.borrar(r.id); resumen.borradas++; }
    }

    estado.fase = 'indexando'; estado.total = cola.length; estado.inicioProceso = Date.now(); alCambiar();
    if (cola.length) await modelo.vision();
    estado.inicioProceso = Date.now();
    const fotos = cola.filter(t => t.tipo === 'f'), videos = cola.filter(t => t.tipo === 'v');
    const lotes = [];
    for (let i = 0; i < fotos.length; i += LOTE) lotes.push(fotos.slice(i, i + LOTE));
    const preparar = l => l ? Promise.all(l.map(prepararFoto)) : null;
    let siguiente = preparar(lotes[0]);
    for (let i = 0; i < lotes.length && !estado.cancelar; i++) {
      const prep = await siguiente;
      siguiente = preparar(lotes[i + 1]); // mientras el modelo trabaja, se van leyendo las fotos del lote que sigue
      for (const t of lotes[i]) { const id = indice.porClave.get(indice.clave(t.lib, t.rel)); if (id) medios.borrarMinis(id, indice.archivos.get(id).ts); }
      await indexarFotos(lotes[i], prep);
      resumen.errores += prep.filter(p => p.error).length;
      estado.hechas += lotes[i].length; medir();
    }
    if (siguiente) await siguiente.catch(() => {});
    for (const t of videos) {
      if (estado.cancelar) break;
      const id = indice.porClave.get(indice.clave(t.lib, t.rel));
      if (id) medios.borrarMinis(id, indice.archivos.get(id).ts);
      await indexarVideo(t);
      const r = indice.archivos.get(indice.porClave.get(indice.clave(t.lib, t.rel)));
      if (r && r.err) resumen.errores++;
      estado.hechas++; medir();
    }
    await completar();
    indice.compactarSiConviene();
  } catch (e) {
    estado.aviso = 'El indexado se interrumpió: ' + String(e.message || e).slice(0, 200);
  } finally {
    resumen.segundos = Math.round((Date.now() - estado.inicio) / 100) / 10;
    resumen.procesadas = estado.hechas; resumen.cancelado = estado.cancelar; resumen.fin = Date.now();
    resumen.porSeg = estado.porSeg;
    const huboTrabajo = resumen.procesadas || resumen.borradas || resumen.desconectadas.length || !estado.ultimo;
    Object.assign(estado, { activo: false, fase: 'listo', ultimo: huboTrabajo ? resumen : estado.ultimo, cancelar: false }); // una pasada sin novedades no pisa el resumen anterior
    alCambiar();
  }
  if (estado.otraVez) { const o = estado.otraVez; estado.otraVez = null; return indexar(o); }
  return estado;
}

function quitarBiblioteca(id) {
  for (const r of [...indice.archivos.values()]) if (r.lib === id) { medios.borrarMinis(r.id, r.ts); indice.borrar(r.id); }
  indice.compactarSiConviene();
}

module.exports = { estado, indexar, quitarBiblioteca, cancelar() { if (estado.activo) estado.cancelar = true; }, alCambiar(f) { alCambiar = f; } };
