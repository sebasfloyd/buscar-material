// Proceso aparte para el modelo de visión: recibe lotes de imágenes ya preparadas y devuelve sus huellas.
// Lo arranca modelo.cjs. Si el buscador se cierra, este proceso se va con él.
const modelo = require('./modelo.cjs');

function irse() { try { process.kill(process.pid, 'SIGKILL'); } catch {} process.exit(0); } // salida en seco: onnxruntime aborta si se sale normal
process.on('disconnect', irse);
process.on('message', async m => {
  try {
    if (m.calentar) { await modelo.vision(); return process.send({ id: m.id, out: true }); }
    const px = m.lote.length / m.n, tensores = [];
    for (let i = 0; i < m.n; i++) tensores.push(m.lote.subarray(i * px, (i + 1) * px));
    const vs = await modelo.vectoresDeImagenes(tensores);
    const out = new Float32Array(m.n * modelo.DIM);
    vs.forEach((v, i) => out.set(v, i * modelo.DIM));
    process.send({ id: m.id, out });
  } catch (e) { process.send({ id: m.id, error: String((e && e.message) || e).slice(0, 300) }); }
});
