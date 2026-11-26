// Modelo de visión y de texto (SigLIP 2) corriendo en la compu, sin llamadas a servicios de IA.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { dep, MODELOS, DATOS, leerJson, escribirJson } = require('./util.cjs');

const MODELO = 'onnx-community/siglip2-base-patch16-256-ONNX';
const DIM = 768;
const LADO = 256;
const SUFIJO = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16' };
function descargado(cual, dtype) { return fs.existsSync(path.join(MODELOS, ...MODELO.split('/'), 'onnx', `${cual}_model${SUFIJO[dtype] ?? '_' + dtype}.onnx`)); }

// Variantes elegidas midiendo con 940 fotos y 29 consultas en español (ver "Límites" en SKILL.md):
// q4f16 busca igual que la precisión completa y pesa mucho menos; q8 es más rápida pero busca peor.
// Visión: las huellas de variantes distintas no se mezclan, así que un índice sigue siempre con la variante con que se creó.
const F_META = path.join(DATOS, 'meta.json');
function variantes() {
  const meta = leerJson(F_META, null);
  let vision = process.env.BUSCAR_DTYPE_VISION || (meta && meta.vision);
  if (!vision) { // índice de la primera versión (sin anotar): se hizo con fp32
    let hayIndice = false; try { hayIndice = fs.statSync(path.join(DATOS, 'vectores.bin')).size > 0; } catch {}
    vision = hayIndice ? 'fp32' : 'q4f16';
  }
  // Texto: no afecta al índice. Si ya está bajada la variante anterior (fp16), se usa esa y no se baja nada nuevo.
  const texto = process.env.BUSCAR_DTYPE_TEXTO || (!descargado('text', 'q4f16') && descargado('text', 'fp16') ? 'fp16' : 'q4f16');
  return { vision, texto, anotar() { if (!meta || meta.vision !== vision) { try { fs.mkdirSync(DATOS, { recursive: true }); escribirJson(F_META, { vision, modelo: MODELO }); } catch {} } } };
}
const V = variantes();
const DTYPE_VISION = V.vision, DTYPE_TEXTO = V.texto;

let T = null;
function transformers() {
  if (!T) {
    T = dep('@huggingface/transformers');
    T.env.cacheDir = MODELOS;
    T.env.allowLocalModels = false;
  }
  return T;
}

// Primero intenta con lo que ya está descargado (funciona sin internet); si falta, lo baja.
async function cargar(Clase, opciones) {
  try { return await Clase.from_pretrained(MODELO, { ...opciones, local_files_only: true }); }
  catch { return await Clase.from_pretrained(MODELO, opciones); }
}

function hilos() {
  const n = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4;
  return n <= 4 ? n : n <= 8 ? n - 2 : Math.min(8, n - 4); // deja aire para que la compu siga usable
}

let _texto = null, _vision = null;
function texto() {
  if (!_texto) {
    const t = transformers();
    _texto = Promise.all([
      cargar(t.AutoTokenizer, {}),
      cargar(t.SiglipTextModel, { dtype: DTYPE_TEXTO, device: 'cpu', session_options: { intraOpNumThreads: Math.min(4, hilos()) } }),
    ]).catch(e => { _texto = null; throw e; });
  }
  return _texto;
}
function vision(progreso) {
  if (!_vision) {
    V.anotar();
    _vision = cargar(transformers().SiglipVisionModel, { dtype: DTYPE_VISION, device: 'cpu', session_options: { intraOpNumThreads: hilos() }, progress_callback: progreso })
      .catch(e => { _vision = null; throw e; });
  }
  return _vision;
}

function normalizarVector(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

const cacheTexto = new Map();
async function vectorDeTexto(consulta) {
  const q = String(consulta).toLowerCase().trim().replace(/\s+/g, ' '); // SigLIP 2 se entrenó con texto en minúsculas
  if (cacheTexto.has(q)) { const v = cacheTexto.get(q); cacheTexto.delete(q); cacheTexto.set(q, v); return v; }
  const [tok, modelo] = await texto();
  const entrada = tok([q], { padding: 'max_length', max_length: 64, truncation: true });
  const salida = await modelo(entrada);
  const v = normalizarVector(salida.pooler_output.data);
  cacheTexto.set(q, v);
  if (cacheTexto.size > 400) cacheTexto.delete(cacheTexto.keys().next().value);
  return v;
}

// tensores: lista de Float32Array (3 x 256 x 256). Devuelve una lista de vectores normalizados.
async function vectoresDeImagenes(tensores) {
  const modelo = await vision();
  const t = transformers();
  const px = 3 * LADO * LADO;
  const lote = new Float32Array(tensores.length * px);
  tensores.forEach((x, i) => lote.set(x, i * px));
  const salida = await modelo({ pixel_values: new t.Tensor('float32', lote, [tensores.length, 3, LADO, LADO]) });
  const datos = salida.pooler_output.data;
  const res = [];
  for (let i = 0; i < tensores.length; i++) res.push(normalizarVector(datos.subarray(i * DIM, (i + 1) * DIM)));
  return res;
}

// Suelta las sesiones antes de salir: si el proceso termina con ellas abiertas, onnxruntime aborta con un error feo.
async function liberar() {
  for (const p of [_texto, _vision]) {
    if (!p) continue;
    try { const m = await p; const lista = Array.isArray(m) ? m : [m]; for (const x of lista) if (x && x.dispose) await x.dispose(); } catch {}
  }
  _texto = null; _vision = null;
}

module.exports = { liberar, MODELO, DIM, DTYPE_VISION, DTYPE_TEXTO, texto, vision, vectorDeTexto, vectoresDeImagenes };
