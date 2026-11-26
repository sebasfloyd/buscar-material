// Capturas de la interfaz con un navegador sin ventana, sobre el servidor que dejó abierto ci.mjs.
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const SALIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'salida');
const res = JSON.parse(fs.readFileSync(fs.readdirSync(SALIDA).filter(f => f.startsWith('resultados-')).map(f => path.join(SALIDA, f))[0], 'utf8'));
const b = await chromium.launch();
const errores = [];
for (const tema of ['light', 'dark']) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: tema })).newPage();
  p.on('pageerror', e => errores.push(e.message)); p.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
  await p.goto(res.url); await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(SALIDA, `${res.sistema}-inicio-${tema}.png`) });
  await p.keyboard.type('pizza'); await p.waitForFunction(() => document.querySelectorAll('.c.ok').length > 2, null, { timeout: 30000 }); await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(SALIDA, `${res.sistema}-busqueda-${tema}.png`) });
  await p.focus('#q'); await p.keyboard.press('ArrowDown'); await p.keyboard.press(' '); await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(SALIDA, `${res.sistema}-vista-rapida-${tema}.png`) });
}
await b.close();
fs.writeFileSync(path.join(SALIDA, `consola-${res.sistema}.json`), JSON.stringify(errores, null, 1));
if (errores.length) { console.log('Errores de consola:', errores); process.exit(1); }
console.log('Capturas listas, consola sin errores');
