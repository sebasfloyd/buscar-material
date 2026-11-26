// Búsqueda: parecido semántico + coincidencia por nombre y carpeta, filtros, duplicados y búsquedas de ejemplo.
const path = require('path');
const indice = require('./indice.cjs');
const modelo = require('./modelo.cjs');
const bibliotecas = require('./bibliotecas.cjs');
const { DATOS, HOME, palabrasClave, normalizar, leerJson, escribirJson } = require('./util.cjs');
const VOCABULARIO = require('./vocabulario.cjs');

// SigLIP da cosenos bajos (0,10 ya es un buen acierto) y cada consulta tiene su propia escala, así que un umbral fijo no sirve.
// El corte se calcula por consulta: cuánto se despega cada foto del resto del índice, corrigiendo las fotos que "se parecen a todo".
const P = {
  sesgo: Number(process.env.BUSCAR_P_SESGO ?? 1),     // cuánto se descuenta a las fotos que puntúan alto con cualquier frase
  zCoincide: Number(process.env.BUSCAR_P_Z1 ?? 4),      // desvíos sobre la mediana para contar como coincidencia
  zRelacionada: Number(process.env.BUSCAR_P_Z2 ?? 2.5), // desvíos para aparecer como relacionada
  pisoCoincide: Number(process.env.BUSCAR_P_PISO ?? 0.06),
  zFoto: Number(process.env.BUSCAR_P_ZFOTO ?? 3),         // desvíos sobre lo normal para esa foto
  pisoFoto: Number(process.env.BUSCAR_P_PISOFOTO ?? 0.08),
  altoSeguro: Number(process.env.BUSCAR_P_ALTO ?? 0.125), // con este coseno es coincidencia aunque media biblioteca sea de lo mismo
  color: Number(process.env.BUSCAR_P_COLOR ?? 0.05),    // empujón a las fotos cuyo borde es del color de fondo pedido
  colorModo: process.env.BUSCAR_P_COLORMODO || 'mezcla',
  maxRelacionadas: 200,
  modo: process.env.BUSCAR_P_MODO || 'z',               // 'v1' reproduce el corte anterior, para comparar
};
const PISO_IMAGEN = 0.62, IMAGEN_COINCIDE = 0.75;      // "parecidas": coseno entre dos imágenes
const BONO_NOMBRE = 1;                                  // lo que coincide por nombre, carpeta, cliente o etiqueta va primero

const imagenes = new Map(); // ref -> vector de una imagen arrastrada o pegada
let nImagen = 0;
function guardarImagen(vec) {
  const ref = 'i' + (++nImagen);
  imagenes.set(ref, vec);
  if (imagenes.size > 6) imagenes.delete(imagenes.keys().next().value);
  return ref;
}

function armarFiltro(f = {}) {
  const desde = f.desde ? Date.parse(f.desde) : 0;
  const hasta = f.hasta ? Date.parse(f.hasta) + 86400000 : 0;
  const etq = (f.etiquetas || []).map(x => String(x).toLowerCase());
  return r => (!f.lib || r.lib === f.lib)
    && (f.cliente == null || f.cliente === '' || r._cliente === f.cliente)
    && (!f.tipo || r.tipo === f.tipo)
    && (!f.orient || r._orient === f.orient)
    && (!desde || r.fecha >= desde) && (!hasta || r.fecha < hasta)
    && (!f.uso || (f.uso === 'sin' ? !r._usada : !!r._usada))
    && (!etq.length || etq.every(e => r._etiquetas.includes(e)));
}

// ---------- color de fondo pedido en la consulta ----------
const COLORES = [
  [/\b(negr[oa]s?|oscur[oa]s?)\b/, (h, s, v) => v < 0.24],
  [/\b(blanc[oa]s?|clar[oa]s?)\b/, (h, s, v) => v > 0.84 && s < 0.13],
  [/\bgris(es)?\b/, (h, s, v) => s < 0.13 && v > 0.25 && v < 0.82],
  [/\broj[oa]s?\b/, (h, s, v) => s > 0.4 && v > 0.3 && (h < 14 || h > 345)],
  [/\bnaranjas?\b/, (h, s, v) => s > 0.4 && v > 0.45 && h >= 14 && h < 42],
  [/\bamarill[oa]s?\b/, (h, s, v) => s > 0.35 && v > 0.5 && h >= 42 && h < 68],
  [/\bverdes?\b/, (h, s, v) => s > 0.2 && v > 0.15 && h >= 68 && h < 165],
  [/\bcelestes?\b/, (h, s, v) => s > 0.15 && v > 0.55 && h >= 165 && h < 215],
  [/\bazul(es)?\b/, (h, s, v) => s > 0.25 && v > 0.15 && h >= 195 && h < 260],
  [/\b(violetas?|lilas?|morad[oa]s?)\b/, (h, s, v) => s > 0.2 && h >= 260 && h < 300],
  [/\brosas?|rosad[oa]s?\b/, (h, s, v) => s > 0.12 && v > 0.6 && (h >= 300 || h < 10) && s < 0.7],
  [/\b(marron(es)?|madera)\b/, (h, s, v) => s > 0.25 && v > 0.15 && v < 0.65 && h >= 10 && h < 45],
  [/\b(beige|crema)\b/, (h, s, v) => s > 0.06 && s < 0.35 && v > 0.75 && h >= 20 && h < 65],
];
// "sushi sobre fondo negro" -> { f: prueba de color, resto: "sushi" }. El modelo busca "sushi"; el color lo decide el borde de la foto.
const FRASE_FONDO = /\s*\b(?:(?:sobre|con|en)\s+)?(?:un\s+|una\s+)?fondo\s+(?:de\s+)?(?:color\s+)?([a-zñáéíóú]+)\b/i;
function colorPedido(texto) {
  const m = FRASE_FONDO.exec(texto);
  if (!m) return null;
  const palabra = normalizar(m[1]);
  for (const [re, f] of COLORES) if (re.test(palabra)) return { f, resto: texto.replace(FRASE_FONDO, ' ').replace(/\s+/g, ' ').trim() };
  return null;
}
function coincideColor(bc, color) {
  const f = color.f || color;
  if (!bc || bc[3] < 45) return 0; // borde muy mezclado: no es "un fondo"
  const r = bc[0] / 255, g = bc[1] / 255, b = bc[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return f(h, mx ? d / mx : 0, mx) ? Math.min(1, bc[3] / 80) : 0;
}

// ---------- sesgo de cada foto: cuánto se parece a "cualquier cosa" ----------
// Hay fotos (placas con texto, capturas) que puntúan alto con casi cualquier frase. Se mide cuánto se parece cada una al promedio
// de muchas frases distintas y se le descuenta. Como es un promedio, alcanza con restarle ese vector promedio a la consulta.
const F_CONTROL = path.join(HOME, `control_${modelo.DTYPE_TEXTO}_${VOCABULARIO.length}.json`);
let control = null; // { lista: [vectores de frases variadas], medio: su promedio }
async function vectoresDeControl() {
  if (control) return control;
  let lista = null;
  const guardado = leerJson(F_CONTROL, null);
  if (guardado && guardado.length && guardado[0].length === modelo.DIM) lista = guardado.map(v => Float32Array.from(v));
  if (!lista) {
    lista = [];
    for (let i = 0; i < VOCABULARIO.length; i += 5) lista.push(await modelo.vectorDeTexto(VOCABULARIO[i]));
    try { escribirJson(F_CONTROL, lista.map(v => Array.from(v, x => Math.round(x * 1e5) / 1e5))); } catch {}
  }
  const medio = new Float32Array(modelo.DIM);
  for (const v of lista) for (let d = 0; d < medio.length; d++) medio[d] += v[d] / lista.length;
  return (control = { lista, medio });
}
// Para una foto: promedio y desvío de su parecido con las frases de control. Sirve para saber si una consulta
// "le queda" a esa foto mucho mejor que una frase cualquiera, sin importar cuántas fotos parecidas haya en la biblioteca.
const propias = new Map(); // id -> [v0, promedio, desvío]
function propiaDe(r) {
  const c = propias.get(r.id);
  if (c && c[0] === r.v0) return c;
  const q = r.v0 + (r.vn >> 1);
  let s = 0, s2 = 0;
  const fila = indice.vectorDeFila(q);
  for (const v of control.lista) { let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * fila[i]; s += d; s2 += d * d; }
  const n = control.lista.length, m = s / n;
  const e = [r.v0, m, Math.sqrt(Math.max(1e-8, s2 / n - m * m))];
  propias.set(r.id, e);
  return e;
}

// "IMG_4231", "DSC0042.jpg": eso es un nombre de archivo, no una descripción. Se busca solo por nombre.
function pareceArchivo(t) { return !/\s/.test(t.trim()) && (/\d{3,}/.test(t) || /_/.test(t) || /\.[a-z0-9]{2,4}$/i.test(t)); }

// Consultas que el modelo entiende mejor dichas de otra forma. Se promedian las huellas de las variantes (medido: ver SKILL.md).
const REFORMULAR = [
  [/ (much[oa]s?|un monton de|llen[oa] de) (gente|personas) /, ['una multitud', 'un grupo grande de personas']], // medido: de 9 a 10 aciertos en los 10 primeros
];
async function vectorDeConsulta(texto) {
  const variantes = [texto];
  if (process.env.BUSCAR_ENSAMBLE) variantes.push('una foto de ' + texto);
  const t = ' ' + normalizar(texto) + ' ';
  for (const [re, extras] of REFORMULAR) if (re.test(t)) variantes.push(...extras);
  if (variantes.length === 1) return modelo.vectorDeTexto(texto);
  const suma = new Float32Array(modelo.DIM);
  for (const v of variantes) { const x = await modelo.vectorDeTexto(v); for (let i = 0; i < suma.length; i++) suma[i] += x[i]; }
  let n = 0; for (const x of suma) n += x * x; n = Math.sqrt(n) || 1;
  return suma.map(x => x / n);
}

const cache = new Map();
// Devuelve { lista: [[id, puntaje, segundo|null, porNombre, seccion]], coinciden } con seccion 0 = coincidencia, 1 = relacionada.
async function ordenar(p) {
  const k = JSON.stringify([p.q || '', p.similar || 0, p.t ?? null, p.imagen || '', p.filtros || {}, p.orden || '', indice.version]);
  if (cache.has(k)) return cache.get(k);
  const pasa = armarFiltro(p.filtros);
  let qv = null, esImagen = false, excluir = 0, color = null;
  const texto = (p.q || '').trim();
  if (p.imagen) { qv = imagenes.get(p.imagen); esImagen = true; if (!qv) throw new Error('La imagen de la búsqueda ya no está en memoria. Arrastrala de nuevo.'); }
  else if (p.similar) {
    const r = indice.archivos.get(+p.similar);
    if (!r || !r.vn) throw new Error('Esa foto todavía no tiene huella para comparar.');
    const i = r.ts && p.t != null ? Math.max(0, r.ts.indexOf(+p.t)) : 0;
    qv = indice.vectorDeFila(r.v0 + i); esImagen = true; excluir = r.id;
  } else if (texto && !pareceArchivo(texto)) {
    color = P.color ? colorPedido(texto) : null;
    qv = await vectorDeConsulta(texto);
    if (color && color.resto && P.colorModo !== 'entero') { // mezcla: la frase entera (el modelo algo entiende de colores) y la frase sin el fondo
      const b = await vectorDeConsulta(color.resto);
      if (P.colorModo === 'resto') qv = b;
      else { const m = new Float32Array(qv.length); let n = 0; for (let i = 0; i < m.length; i++) { m[i] = qv[i] + b[i]; n += m[i] * m[i]; } n = Math.sqrt(n); qv = m.map(x => x / n); }
    }
  }
  const soloNombre = !!texto && !qv;
  const claves = esImagen ? [] : palabrasClave(texto);
  const conSesgo = qv && !esImagen && P.sesgo && P.modo !== 'v1';
  let qa = qv; // consulta ajustada: la misma, menos lo que tienen en común todas las frases
  if (conSesgo) { const c = (await vectoresDeControl()).medio; qa = new Float32Array(qv.length); for (let i = 0; i < qv.length; i++) qa[i] = qv[i] - P.sesgo * c[i]; }

  // se puntúa todo el índice (no solo lo filtrado) para saber qué es "normal" para esta consulta
  const todos = [], filtrados = [];
  for (const r of indice.archivos.values()) {
    if (r.id === excluir) continue;
    const ok = pasa(r);
    let s = null, seg = null, nombre = 0, crudo = null;
    if (qv && r.vn) {
      const [v, c] = indice.parecido(r, qa); s = v; if (r.ts) seg = r.ts[c];
      todos.push(s);
    }
    if (!ok) continue;
    if (claves.length && !process.env.BUSCAR_SIN_NOMBRE) { nombre = 1; for (const c of claves) if (!r._texto.includes(' ' + c)) { nombre = 0; break; } }
    if (soloNombre) { if (nombre) filtrados.push([r.id, 0, null, 1, 0]); continue; }
    if (!qv) { filtrados.push([r.id, 0, null, 0, 0]); continue; }
    if (s === null && !nombre) continue;
    let orden = s === null ? -1 : s;
    if (color && s !== null) orden += P.color * coincideColor(r.bc, color);
    filtrados.push([r.id, 0, seg, nombre, 0, orden, s]);
  }

  let res = filtrados, coinciden = filtrados.length;
  if (qv) {
    if (esImagen) {
      for (const x of filtrados) x[1] = x[6];
      res = filtrados.filter(x => x[1] >= PISO_IMAGEN);
      for (const x of res) x[4] = x[1] >= IMAGEN_COINCIDE ? 0 : 1;
    } else if (P.modo === 'v1') {
      let tope = -2; for (const x of filtrados) if (x[6] !== null && x[6] > tope) tope = x[6];
      const corte = Math.max(0.07, tope * 0.65);
      for (const x of filtrados) x[1] = x[6] === null ? 0 : x[6];
      res = filtrados.filter(x => x[3] || x[6] >= corte);
    } else {
      todos.sort((a, b) => a - b);
      const med = todos.length ? todos[todos.length >> 1] : 0;
      const desv = todos.map(v => Math.abs(v - med)).sort((a, b) => a - b);
      const mad = Math.max(0.004, (desv[desv.length >> 1] || 0) * 1.4826);
      res = [];
      for (const x of filtrados) {
        if (x[6] === null) { if (x[3]) res.push(x); continue; }
        const z = (x[6] - med) / mad;
        const r = indice.archivos.get(x[0]);
        x[1] = indice.parecido(r, qv)[0]; // el coseno sin ajustar: es el puntaje que se informa
        // segunda mirada, por foto: ¿esta consulta le queda mucho mejor que una frase cualquiera? Rescata las búsquedas amplias
        // ("comida" en la biblioteca de un restaurante), donde casi todo coincide y nada se despega del resto.
        const pr = propiaDe(r), zf = (x[1] - pr[1]) / pr[2];
        const fuerte = (z >= P.zCoincide && x[1] >= P.pisoCoincide) || (zf >= P.zFoto && x[1] >= P.pisoFoto) || x[1] >= P.altoSeguro;
        if (x[3] || fuerte) x[4] = 0;
        else if (z >= P.zRelacionada && x[1] >= P.pisoCoincide * 0.8) x[4] = 1;
        else continue;
        res.push(x);
      }
    }
    const A = indice.archivos;
    const porRelevancia = (a, b) => (b[5] + b[3] * BONO_NOMBRE) - (a[5] + a[3] * BONO_NOMBRE);
    if (p.orden === 'fecha' || p.orden === 'fecha_asc') {
      const d = p.orden === 'fecha' ? -1 : 1;
      res.sort((a, b) => a[4] - b[4] || d * (A.get(a[0]).fecha - A.get(b[0]).fecha) || a[0] - b[0]);
    } else res.sort((a, b) => a[4] - b[4] || porRelevancia(a, b));
    coinciden = res.filter(x => x[4] === 0).length;
    if (res.length - coinciden > P.maxRelacionadas) { // las relacionadas son un extra: se acotan a las mejores
      const rel = res.slice(coinciden).sort(porRelevancia).slice(0, P.maxRelacionadas);
      const quedan = new Set(rel.map(x => x[0]));
      res = res.filter(x => x[4] === 0 || quedan.has(x[0]));
    }
  } else {
    const A = indice.archivos, d = p.orden === 'fecha_asc' ? 1 : -1;
    res.sort((a, b) => d * (A.get(a[0]).fecha - A.get(b[0]).fecha) || a[0] - b[0]);
  }
  const salida = { lista: res, coinciden };
  cache.set(k, salida);
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return salida;
}

function ficha(r, puntaje, seg, nombre) {
  const i = r.rel.lastIndexOf('/');
  return {
    id: r.id, n: r._nombre, c: r._cliente, l: r.lib, d: i < 0 ? '' : r.rel.slice(0, i), k: r.tipo,
    w: r.w || 0, h: r.h || 0, f: r.fecha, s: r.tam, dur: r.dur || 0,
    p: Math.round(puntaje * 1000) / 1000, t: seg, nm: nombre || 0,
    m: r.err || r.sinCuadros ? 0 : 1, e: r.err || '', v: r.mod % 100000,
    et: r._etiquetas, us: r._usada || 0, hr: r.hr ? 1 : 0,
  };
}

async function buscar(p) {
  const t0 = performance.now();
  const { lista, coinciden } = await ordenar(p);
  const desde = Math.max(0, p.desde | 0), cuantos = Math.min(2000, Math.max(1, p.limite | 0 || 300));
  const items = [];
  for (const x of lista.slice(desde, desde + cuantos)) {
    const r = indice.archivos.get(x[0]);
    if (r) items.push(ficha(r, x[1], x[2], x[3]));
  }
  return { total: lista.length, coinciden, desde, items, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

// ---------- duplicados ----------
function distancia(a, b) { // bits distintos entre dos dHash en hexadecimal
  let d = 0;
  for (let i = 0; i < 16; i += 4) { let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16); while (x) { d++; x &= x - 1; } }
  return d;
}
let dupCache = { version: 0, grupos: [] };
function duplicados() {
  if (dupCache.version === indice.version) return dupCache.grupos;
  const padre = new Map();
  const raiz = x => { while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); } return x; };
  const unir = (a, b) => { a = raiz(a); b = raiz(b); if (a !== b) padre.set(b, a); };
  const lista = [...indice.archivos.values()].filter(r => r.hr);
  for (const r of lista) padre.set(r.id, r.id);
  const identicas = new Set();
  const porHash = new Map();
  for (const r of lista) { const o = porHash.get(r.hr); if (o) { unir(o, r.id); identicas.add(o); identicas.add(r.id); } else porHash.set(r.hr, r.id); }
  // "Casi iguales": cada grupo se arma alrededor de una foto de referencia y solo entran las que se parecen a ESA foto.
  // Así A~B y B~C no arrastran a C con A (una animación cuadro a cuadro ya no queda en un solo grupo).
  const fotos = lista.filter(r => r.dh && r.vn && r.tipo === 'f').sort((a, b) => b.tam - a.tam || a.id - b.id);
  const cubos = Array.from({ length: 8 }, () => new Map());
  const asignada = new Set();
  for (const r of fotos) for (let b = 0; b < 8; b++) { const k = r.dh.slice(b * 2, b * 2 + 2); let c = cubos[b].get(k); if (!c) cubos[b].set(k, c = []); c.push(r); }
  for (const ref of fotos) {
    if (asignada.has(ref.id)) continue;
    const q = indice.vectorDeFila(ref.v0);
    for (let b = 0; b < 8; b++) {
      const c = cubos[b].get(ref.dh.slice(b * 2, b * 2 + 2));
      if (!c || c.length > 2000) continue;
      for (const o of c) {
        if (o === ref || asignada.has(o.id) || raiz(o.id) === raiz(ref.id)) continue;
        if (distancia(ref.dh, o.dh) <= 6 && indice.parecido(o, q)[0] >= 0.95) { unir(ref.id, o.id); asignada.add(o.id); asignada.add(ref.id); }
      }
    }
  }
  const grupos = new Map();
  for (const r of lista) { const k = raiz(r.id); let g = grupos.get(k); if (!g) grupos.set(k, g = []); g.push(r); }
  const salida = [];
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.tam - a.tam || a.id - b.id);
    const exacto = g.every(r => r.hr === g[0].hr);
    salida.push({ exacto, sobra: g.slice(1).reduce((s, r) => s + r.tam, 0), items: g.map(r => ficha(r, 0, null, 0)) });
  }
  salida.sort((a, b) => b.sobra - a.sobra);
  dupCache = { version: indice.version, grupos: salida };
  return salida;
}

// ---------- búsquedas de ejemplo sacadas de lo que hay indexado ----------
// Se agrupan las fotos del índice por parecido (k-medias sobre sus huellas) y para cada grupo se elige,
// de un vocabulario amplio, la frase que lo describe mejor que a los demás grupos. Lo que no está en el material no aparece.
const F_EJEMPLOS = path.join(DATOS, 'ejemplos.json');
let ejemplos = null, calculando = false;
function firma() { return indice.archivos.size + ':' + indice.filas; }
function ejemplosActuales() {
  if (!ejemplos) ejemplos = leerJson(F_EJEMPLOS, { firma: '', lista: [] });
  return ejemplos.lista.filter(e => indice.archivos.has(e.id));
}
function agrupar(filas, k) {
  const D = filas[0].length, n = filas.length;
  let centros = Array.from({ length: k }, (_, i) => Float32Array.from(filas[Math.floor(i * n / k)]));
  const dueño = new Int32Array(n);
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    for (let i = 0; i < n; i++) { let mejor = -2, cual = 0; for (let c = 0; c < k; c++) { let s = 0; const a = filas[i], b = centros[c]; for (let d = 0; d < D; d++) s += a[d] * b[d]; if (s > mejor) { mejor = s; cual = c; } } dueño[i] = cual; }
    const suma = Array.from({ length: k }, () => new Float32Array(D)), cuenta = new Int32Array(k);
    for (let i = 0; i < n; i++) { const s = suma[dueño[i]]; cuenta[dueño[i]]++; for (let d = 0; d < D; d++) s[d] += filas[i][d]; }
    centros = suma.map((s, c) => { if (!cuenta[c]) return centros[c]; let m = 0; for (let d = 0; d < D; d++) m += s[d] * s[d]; m = Math.sqrt(m) || 1; return s.map(x => x / m); });
  }
  return { centros, dueño };
}
async function calcularEjemplos() {
  if (calculando || indice.filas < 12) return;
  if (!ejemplos) ejemplos = leerJson(F_EJEMPLOS, { firma: '', lista: [] });
  if (ejemplos.firma === firma()) return;
  calculando = true;
  try {
    const f = firma();
    let regs = [...indice.archivos.values()].filter(r => r.vn);
    if (regs.length > 3000) { const paso = regs.length / 3000; regs = Array.from({ length: 3000 }, (_, i) => regs[Math.floor(i * paso)]); }
    const filas = regs.map(r => indice.vectorDeFila(r.v0 + (r.vn >> 1)));
    const k = Math.max(2, Math.min(14, Math.floor(regs.length / 20)));
    const { centros, dueño } = agrupar(filas, k);
    const tam = new Int32Array(k); dueño.forEach(c => tam[c]++);
    const frases = [];
    for (const t of VOCABULARIO) { frases.push([t, await modelo.vectorDeTexto(t)]); await new Promise(r => setImmediate(r)); }
    const punt = frases.map(([, v]) => centros.map(c => { let s = 0; for (let d = 0; d < v.length; d++) s += v[d] * c[d]; return s; }));
    const usadas = new Set(), lista = [];
    for (const c of [...tam.keys()].sort((a, b) => tam[b] - tam[a])) {
      if (tam[c] < Math.max(4, regs.length * 0.02)) continue;
      let mejor = -1, cual = -1;
      for (let i = 0; i < frases.length; i++) {
        if (usadas.has(i)) continue;
        const otros = (punt[i].reduce((a, b) => a + b, 0) - punt[i][c]) / (k - 1);
        const d = punt[i][c] - otros; // qué tan propia de este grupo es la frase
        if (punt[i][c] > 0.06 && d > mejor) { mejor = d; cual = i; }
      }
      if (cual < 0 || mejor < 0.012) continue;
      usadas.add(cual);
      const qv = frases[cual][1];
      let top = -2, id = 0;
      regs.forEach((r, i) => { if (dueño[i] !== c) return; const s = indice.parecido(r, qv)[0]; if (s > top) { top = s; id = r.id; } });
      if (top >= 0.085) lista.push({ frase: frases[cual][0], id, n: tam[c] });
      if (lista.length >= 6) break;
    }
    ejemplos = { firma: f, lista };
    escribirJson(F_EJEMPLOS, ejemplos);
  } catch (e) { console.error('ejemplos:', e.message); } finally { calculando = false; }
}

// ---------- resumen para la interfaz ----------
let resumenCache = { version: 0 };
function resumen() {
  if (resumenCache.version === indice.version) return resumenCache;
  const libs = new Map(bibliotecas.todas().map(b => [b.id, { fotos: 0, videos: 0 }]));
  const clientes = new Map(), anios = new Map();
  let fotos = 0, videos = 0, conError = 0, sinCuadros = 0;
  for (const r of indice.archivos.values()) {
    const l = libs.get(r.lib);
    if (r.tipo === 'v') { videos++; if (l) l.videos++; } else { fotos++; if (l) l.fotos++; }
    if (r.err) conError++;
    if (r.sinCuadros) sinCuadros++;
    if (r._cliente) { const k = r.lib + '|' + r._cliente; clientes.set(k, (clientes.get(k) || 0) + 1); }
    const a = new Date(r.fecha).getFullYear(); anios.set(a, (anios.get(a) || 0) + 1);
  }
  resumenCache = {
    version: indice.version, fotos, videos, conError, sinCuadros, libs,
    clientes: [...clientes].map(([k, n]) => ({ lib: k.slice(0, k.indexOf('|')), nombre: k.slice(k.indexOf('|') + 1), n })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    anios: [...anios.keys()].sort((a, b) => b - a),
  };
  return resumenCache;
}

module.exports = { P, REFORMULAR, colorPedido, coincideColor, buscar, ordenar, ficha, guardarImagen, duplicados, calcularEjemplos, ejemplosActuales, resumen };
