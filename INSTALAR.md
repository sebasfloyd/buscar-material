# Instalar el buscador de material

Instrucciones para Claude (la Mente). Seguilas en orden. La persona no usa la terminal: todo lo corrés vos y le contás en una o dos líneas qué está pasando.

## 1. Dónde va

La skill va en `.claude/skills/buscar-material/` dentro de la carpeta de la Mente (la carpeta de trabajo actual). Si esa carpeta ya existe, es una actualización: andá al paso 6.

- **Desde el repositorio** (te pasaron una dirección de GitHub):
  `git clone <dirección> ".claude/skills/buscar-material"`
  Si falla por permisos, decile a la persona que pida acceso al repositorio o el archivo zip, y frená.
- **Desde un zip** (te arrastraron `buscar-material.zip`): descomprimilo dentro de `.claude/skills/buscar-material/`. Tiene que quedar `SKILL.md` directamente en esa carpeta, no en una subcarpeta.
  - Mac: `mkdir -p .claude/skills/buscar-material && unzip -o "<zip>" -d .claude/skills/buscar-material`
  - Windows (PowerShell): `Expand-Archive -Force "<zip>" ".claude\skills\buscar-material"`

Si la carpeta de la Mente es un repositorio git compartido por el equipo, la skill instalada desde zip se puede subir con el resto para que todos la tengan. Instalada con `git clone` queda como un repositorio aparte: no la agregues al de la Mente.

## 2. Preparar (una sola vez por compu)

Decile antes: "Voy a bajar unos 600 MB y tarda entre 1 y 10 minutos según tu conexión. Ocupa cerca de 700 MB. Es una sola vez".

- Mac: `sh ".claude/skills/buscar-material/buscar.sh" preparar`
- Windows: `".claude\skills\buscar-material\buscar.cmd" preparar`

El lanzador encuentra Node solo. Si dice que no hay Node, pedile a la persona que instale la versión LTS desde https://nodejs.org, que reinicie la Mente, y volvé a correrlo. Si se corta la conexión, corré `preparar` de nuevo: retoma.

Al terminar deja en el Escritorio el acceso directo **Buscar material**. Contáselo.

## 3. Qué carpeta indexar

Preguntá: "¿En qué carpeta están las fotos y los videos? Puede ser un disco externo; si es así, conectalo". Con la respuesta:

```
buscar biblioteca agregar "<carpeta>" --nombre "<nombre corto>"
buscar indexar
```

(`buscar` es el lanzador del paso 2.) Antes de indexar, decile cuánto va a tardar: entre 5 y 8 fotos por segundo en una Mac reciente, así que 10.000 fotos son unos 30 minutos. Corré el indexado en segundo plano y avisale que puede ir buscando mientras tanto. Los originales no se tocan: decíselo.

## 4. Clientes

Corré `buscar cliente`. Mostrale los nombres que salieron (son las subcarpetas de primer nivel) y preguntá si esos son sus clientes. Si no, corregí con `buscar cliente asignar "<carpeta>" "<Cliente>"` las que te diga.

## 5. Abrir y mostrar

`buscar abrir`. Contale, corto:
- Para abrirlo de nuevo: doble clic en **Buscar material**, en el Escritorio. No hace falta pasar por la Mente.
- Escribe lo que busca en español. Barra espaciadora para ver en grande, Enter para abrir.
- `T` para etiquetar y `U` para marcar una foto como ya usada.
- La guía con capturas está en `guia.pdf`, dentro de la carpeta de la skill. Ofrecé abrírsela.

## 6. Actualizar

`buscar actualizar`. Contale qué cambió con lo que devuelve. Si dice que se instaló desde zip, repetí el paso 1 con el zip nuevo (descomprimir encima) y después corré `buscar preparar`. El índice y las etiquetas no se pierden: viven en `~/.mente-ai/buscar-material/`, fuera de la skill.

## 7. Etiquetas compartidas por el equipo (solo si la Mente se comparte por git)

Por defecto las etiquetas quedan en cada compu. Para que sean de todos, **una sola persona** lo configura una vez:

```
buscar etiquetas ubicacion "<carpeta de la Mente>/material/etiquetas"
```

Después subí esa carpeta al repositorio de la Mente con el commit de siempre. Ahí quedan tres archivos chicos: `etiquetas.jsonl`, `clientes.jsonl` y `.gitattributes` (este último hace que git junte los cambios de dos personas sin marcar conflicto).

**El resto del equipo**, en su compu, después de bajar los cambios de la Mente, corre el mismo comando con la misma carpeta. No pierde lo que ya había etiquetado: se une con lo compartido. Desde ahí cada cambio de etiquetas viaja con el commit y el pull normales de la Mente, y el buscador los toma solo.

Cada foto se reconoce por su contenido y cada biblioteca por sus subcarpetas, así que no importa que en cada compu el disco tenga otra letra, otra ruta u otro nombre.
