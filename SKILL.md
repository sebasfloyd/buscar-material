---
name: buscar-material
description: Buscador local de fotos y videos de los clientes. Un modelo de visión que corre en la compu indexa las carpetas una vez; después se busca escribiendo ("niguiris de salmón sobre fondo negro") en una ventana del navegador, al instante y sin gastar tokens. También guarda etiquetas, cliente por carpeta y qué material ya se usó (y quién lo usó), y los comparte entre las compus del equipo. Usar cuando digan "buscá en el material", "dónde está la foto de", "abrí el buscador", "indexá esta carpeta", "qué fotos tenemos de", "armame posteos con lo que ya tenemos", "marcá estas como usadas", "qué queda sin usar de", "hay fotos repetidas", "compartí las etiquetas con el equipo", "armemos la lista de etiquetas", "quién usó esta foto".
argument-hint: "[qué buscar o qué carpeta sumar]"
allowed-tools: Bash, Read
---

# Buscar material

Vos solo preparás, indexás y abrís. Buscar lo hace la persona en la ventana: eso no pasa por vos ni gasta tokens.

**Los originales no se tocan.** El buscador solo los lee. Nunca muevas, renombres ni borres archivos de una biblioteca, ni siquiera si te lo sugiere la vista de duplicados: eso lo decide y lo hace la persona. Tampoco se escriben metadatos en los archivos ni archivos al lado. Todo lo que se escribe está en `~/.mente-ai/buscar-material/` (herramientas, modelo, índice, miniaturas), en la carpeta de etiquetas compartida si el equipo eligió una, y en la carpeta que la persona elija al exportar copias.

## 1. Cómo correr los comandos

No supongas dónde está Node. Usá el lanzador, que lo busca solo:

- Mac: `sh "<carpeta de esta skill>/buscar.sh" <comando>`
- Windows: `"<carpeta de esta skill>\buscar.cmd" <comando>`

El lanzador prueba el Node de la app de la Mente (`~/.local/node`), el del sistema (`command -v node` o `where node`) y las rutas de instalación habituales, y exige la versión 18 o más nueva. Si no encuentra ninguno lo dice: pedile a la persona que instale la LTS desde https://nodejs.org y frená ahí. En los ejemplos de abajo, `buscar` es ese lanzador.

## 2. Preparación, solo la primera vez

```bash
buscar preparar
```

Avisá antes: baja unos 600 MB (herramientas y modelo), ocupa unos 650 MB en disco y tarda entre 1 y 10 minutos según la conexión. Necesita internet solo esta vez; después todo funciona sin conexión. Si se corta, se vuelve a correr y retoma. Corré en segundo plano si tu entorno lo permite.

`preparar` deja en el Escritorio un acceso directo, "Buscar material", que abre el buscador sin pasar por vos. Decile a la persona que lo use para el día a día: así buscar no gasta nada. Abrirlo dos veces no abre dos buscadores.

Si la compu ya tiene `ffmpeg`, el buscador lo usa para mirar dentro de los videos. Si no, los videos aparecen igual pero se encuentran solo por nombre, carpeta y etiquetas. No instales ffmpeg por tu cuenta: contale la diferencia a la persona y que decida.

## 3. Sumar una carpeta (biblioteca)

```bash
buscar biblioteca agregar "<carpeta>" --nombre "<nombre corto>"
buscar indexar
```

- Puede ser un disco externo. Si después cambia de letra o de ruta: `buscar biblioteca mover "<nombre>" "<carpeta nueva>"` conserva el índice y no vuelve a indexar.
- `indexar` avanza a entre 4 y 8 fotos por segundo en una Mac con Apple Silicon (10.000 fotos, entre 20 y 40 minutos). El indexado arranca solo al agregar la biblioteca; `estado` dice cuántos archivos encontró y cuántos lleva. Decí cuánto va a tardar antes de arrancar y corré en segundo plano. Se puede buscar mientras indexa.
- Es incremental y retoma si se corta. `--reintentar` vuelve a probar los archivos que fallaron. Saltea carpetas ocultas, `node_modules`, cachés y bibliotecas de Fotos o Lightroom.
- Al terminar contá cuántas fotos y videos quedaron, cuántos sin miniatura (`sinMiniatura`) y si los videos quedaron solo por nombre (`videosSoloPorNombre`).

`biblioteca listar` muestra las que hay. `biblioteca quitar "<nombre>"` la saca del buscador sin tocar los archivos.

## 4. Clientes

El cliente de cada foto sale de la carpeta. Al principio se toma la primera subcarpeta de la biblioteca, pero es solo una sugerencia: muchas veces no es el cliente (una carpeta por fecha o por evento). Después de indexar mirá `buscar cliente` y, si los nombres no son clientes, preguntale a la persona y corregí:

```bash
buscar cliente asignar "<carpeta>" "<Cliente>"     # vale para todo lo de adentro; puede ser la biblioteca entera
buscar cliente renombrar "<actual>" "<nuevo>"      # si el nuevo ya existe, los une
```

Gana la regla de la carpeta más específica. La persona también puede hacerlo en la ventana: clic derecho sobre una foto, "Cliente de esta carpeta".

## 5. Abrir el buscador

```bash
buscar abrir
```

Abre `http://127.0.0.1:4517` en el navegador (si el puerto está ocupado usa el siguiente; el comando devuelve la dirección). Al abrir revisa solo si hay material nuevo. Se cierra a los 30 minutos sin uso; `cerrar` lo cierra en el momento.

Contale a la persona lo básico, corto:
- Escribe lo que busca en español. Arriba aparece lo que coincide; debajo, separado, lo "relacionado". También puede arrastrar o pegar una imagen para encontrar parecidas.
- Flechas para moverse, barra espaciadora para la vista rápida, Enter para abrir, Cmd/Ctrl+K o `/` para volver a buscar.
- Cmd/Ctrl+clic y Shift+clic para elegir varias. Con una o varias elegidas: `T` para etiquetar, `U` para marcar como usada, "Exportar copias" o "Copiar rutas".
- Si las etiquetas están compartidas, abajo a la derecha dice "Etiquetas compartidas" y cuándo llegó lo último; ahí mismo se ve la lista del equipo y quiénes escribieron.
- Filtros bajo la barra: cliente, etiqueta, "Sin usar" (un clic; otro clic muestra las ya usadas), orientación, fecha.
- Si un disco no está conectado, sus fotos igual aparecen con la miniatura guardada.

## 6. Etiquetas y material usado

Son un extra: buscar funciona sin etiquetar nada. Sirven para lo que no se ve en la foto (campaña, aprobada por el cliente, dónde se publicó).

```bash
buscar etiquetar "<ruta>" "<ruta>" --agregar "carta verano,aprobada" [--quitar "borrador"]
buscar marcar-usada "<ruta>" "<ruta>" --nota "Instagram 12/11" [--fecha AAAA-MM-DD] [--deshacer]
buscar etiquetas listar
```

Las dos primeras aceptan `--lista archivo.txt` con una ruta por línea. **Cuando entregues piezas armadas con material del buscador, marcá esas fotos como usadas con una nota que diga dónde salieron.** La marca guarda quién la puso y cuándo; `buscar buscar` la devuelve en `usada` y `usadaPor`.

Nada de esto se escribe en los originales. Cada foto se reconoce por su contenido, no por su ruta: si el disco cambia de letra o la carpeta se muda, las etiquetas siguen pegadas.

### Compartirlas con el equipo

Por defecto las etiquetas, las marcas de usada y los clientes quedan en cada compu. Si varias personas usan el buscador sobre el mismo material (cada una con su copia, en la ruta que sea) conviene compartirlos: así nadie repite una foto que otra ya publicó y todas etiquetan con las mismas palabras.

**Cuándo proponerlo:** si la carpeta de la Mente es un repositorio git que el equipo comparte, o si la persona dice "compartí las etiquetas", "que mis compañeras vean lo que marqué" o "no quiero repetir fotos que ya usó otra". Preguntá antes de configurarlo.

**Cómo:** se hace una vez en cada compu, con la misma carpeta dentro de la Mente compartida.

```bash
buscar etiquetas compartir "<raíz de la Mente>/material/etiquetas" --autor "<nombre de la persona>"
```

- La carpeta tiene que estar dentro de lo que el equipo sincroniza y tiene que ser la misma (la misma ruta dentro de la Mente) para todas. Si la Mente ya tiene un lugar para datos compartidos, usá ese, en una subcarpeta `buscar-material`. Si ya hay una carpeta compartida de una versión anterior, usá esa misma.
- `--autor` es el nombre con que figura lo que etiqueta o marca esa persona. Preguntáselo. Si no se indica, se usa el usuario del sistema. Se cambia después con `buscar etiquetas autor "<Nombre>"` y vale desde ese momento.
- Lo que esa compu ya tenía etiquetado se suma a lo compartido, sin pisar lo de nadie.
- El buscador no hace git. Solo lee y escribe archivos en esa carpeta: los cambios salen cuando la persona comparte la Mente (el botón "Compartir" o el commit y push de siempre) y entran cuando la Mente baja lo nuevo. No es al instante. El buscador abierto toma lo que llega solo, sin reiniciar ni reindexar.
- Después de configurarlo, compartí la Mente una vez para que la carpeta llegue al resto.

```bash
buscar etiquetas estado              # si está compartido, dónde, quiénes escribieron, cuándo llegó lo último
buscar etiquetas compartir --dejar   # volver a tenerlas solo en esta compu (se queda con todo lo que había)
```

Si `estado` devuelve `noEncuentroLaCarpeta`, la carpeta se movió o la Mente no está: volvé a indicarla con `etiquetas compartir`. Mientras tanto no se puede etiquetar, para no escribir en un lugar equivocado.

**Cómo está guardado** (para diagnosticar, no para editar a mano): dentro de la carpeta hay `eventos/<compu>.jsonl`, un archivo por compu con una línea por cambio (quién, cuándo, a qué foto). Cada compu escribe solo el suyo, por eso git nunca marca conflicto aunque dos personas editen a la vez. El estado se arma con los archivos de todas: si dos etiquetan la misma foto quedan las etiquetas de las dos, quitar una etiqueta le gana a haberla agregado antes, y en la marca de usada vale la última. No borres ni edites esos archivos: son el historial. Las etiquetas de fotos que una compu todavía no indexó quedan guardadas y aparecen cuando las indexe. Todas las compus tienen que tener la versión 3.1.0 o más nueva.

### Lista acordada de etiquetas

Es el vocabulario del equipo: las etiquetas que conviene usar. No prohíbe las demás. En la ventana se sugieren primero, y las que no están en la lista se ven como "sueltas".

```bash
buscar etiquetas lista ver                         # la lista y, aparte, las sueltas que ya se usan
buscar etiquetas lista agregar "aprobada,carta verano"
buscar etiquetas lista quitar "borrador"           # sale de la lista; las fotos que la tienen la conservan
```

Si está compartido, la lista también viaja. Cuando el equipo arranque, proponé armarla con ellas: mirá las sueltas de `lista ver`, sugerí unificar las que digan lo mismo y agregá las acordadas. En la ventana se maneja desde "Lista del equipo", en el panel de etiquetas (`T`).

## 7. Consultar vos el índice

Cuando te pidan algo que necesita material ("armame 10 posteos con lo que ya tenemos de tal cliente"), consultá el índice en vez de abrir carpetas:

```bash
buscar buscar "<descripción en español>" --n 20 --cliente "<cliente>" --sin-usar
```

Devuelve una línea de JSON con rutas y puntaje. Filtros: `--cliente`, `--etiqueta "a,b"`, `--sin-usar` o `--usadas`, `--tipo foto|video`, `--orientacion vertical|horizontal|cuadrada`, `--desde` y `--hasta` (AAAA-MM-DD), `--orden fecha`. Sin texto, lista lo que pasa los filtros. `estado` lista clientes y bibliotecas. `duplicados` lista los grupos repetidos.

- Los resultados ya vienen ordenados del más al menos relevante; `total` es cuántos hay en todo el índice aunque pidas menos con `--n`. El `puntaje` es orientativo: no lo uses para reordenar.
- `coinciden` dice cuántos de los resultados son coincidencias firmes; los que traen `relacionada: true` son apenas parecidos: no los propongas sin mirarlos. Si `coinciden` es 0, lo más probable es que no haya material de eso: decilo en vez de forzar.
- `porNombre` indica que coincidió el nombre del archivo, la carpeta, el cliente o una etiqueta. En videos, `segundo` es el momento donde aparece lo buscado.
- Hacé varias búsquedas cortas y concretas antes que una larga. Abrí con Read solo las pocas imágenes que vayas a proponer.

## Actualizar

```bash
buscar actualizar
```

Si la skill se instaló desde el repositorio, trae la última versión, cuenta qué cambió y reinstala las herramientas solo si hace falta. Nunca toca el índice, las miniaturas ni las etiquetas. Al pasar a la 3.1.0, las etiquetas que ya había se convierten solas al formato nuevo la primera vez que se abre el buscador, sin perder nada; si el equipo ya compartía la carpeta de etiquetas, sigue compartida. Si se instaló desde un zip, lo dice: se instala el zip nuevo encima. `buscar version` muestra cuál está instalada.

## Límites

- Encuentra bien qué hay en la foto (comida, personas, lugares, objetos, capturas, texto grande). El color de fondo ("sobre fondo negro") se usa para ordenar, no para filtrar. No cuenta: "mucha gente" o "tres platos" los toma como idea general.
- Lee algo del texto grande que aparece en la imagen, no la letra chica.
- HEIC, PSD, TIFF y RAW (probado con CR2, ARW, NEF y DNG) se indexan con su vista previa. Un RAW sin vista previa embebida o un PSD guardado sin compatibilidad queda sin miniatura y se encuentra solo por nombre.
- Probado en Mac con Apple Silicon. Los binarios de Mac con Intel pasaron el flujo completo en emulación (Rosetta), no en una Intel real. En Windows está escrito y revisado, con pruebas de sus rutas, pero todavía no corrió en una compu real: si falla ahí, mostrá el error tal cual.
- Cada índice sigue con la variante del modelo de visión con que se creó (queda anotada en `datos/meta.json`); un índice hecho con la versión anterior sigue funcionando sin volver a indexar ni bajar nada. Si en una compu con Intel el indexado anda muy lento, se puede probar `BUSCAR_DTYPE_VISION=fp32` antes de indexar por primera vez (pesa 320 MB más). La variante `q8` es más rápida pero se midió y busca peor en español: no usarla.
