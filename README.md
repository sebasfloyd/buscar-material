# Buscar material

Un buscador de fotos y videos que corre en tu compu. Escribís lo que buscás ("niguiris de salmón sobre fondo negro") y aparece al instante, aunque los archivos se llamen `IMG_4203.jpg`.

- **No sube nada a internet.** Un modelo de visión mira tus carpetas una vez, en tu compu, y arma un índice local.
- **Buscar no gasta tokens.** La Mente solo instala y abre; después buscás vos en una ventana del navegador.
- **Los originales no se tocan.** El buscador solo lee. No mueve, no renombra, no borra y no escribe nada dentro de tus carpetas de material.
- Sirve también para marcar qué fotos ya se usaron, ponerles etiquetas y encontrar repetidas.

## Qué pide

- Mac o Windows, con la app de la Mente (o Claude Code).
- Unos 650 MB libres y conexión a internet solo la primera vez (baja unos 600 MB).
- Las carpetas con el material, en la compu o en un disco externo.

## Cómo se instala

Abrí la Mente y pegá esto en el chat:

> Instalá el buscador de material desde este repositorio: https://github.com/sebasfloyd/buscar-material. Seguí su INSTALAR.md.

Si preferís no usar git, bajá el zip desde el botón verde **Code → Download ZIP** de esta página, arrastralo al chat y escribí:

> Instalá esta skill.

La Mente te va a avisar cuánto tarda, te va a preguntar qué carpeta querés indexar y te va a dejar en el Escritorio un acceso directo, **Buscar material**, para abrir el buscador cuando quieras.

## Cómo se usa

1. Doble clic en **Buscar material** (o pedile a la Mente "abrí el buscador").
2. Escribí lo que buscás, en español.
3. Flechas para moverte, barra espaciadora para ver en grande, Enter para abrir el archivo.

La guía completa, con capturas, está en `guia.pdf`.

## Cómo se actualiza

Pegá en el chat de la Mente:

> Actualizá el buscador de material.

Trae la última versión y te cuenta qué cambió. El índice y las etiquetas no se pierden. Los cambios de cada versión están en `CHANGELOG.md`.

## Licencia

Libre, con licencia MIT (ver `LICENSE`): se puede usar, copiar, modificar y compartir. Hecho por Ruptive AI.

Usa componentes de terceros con sus propias licencias, que se descargan al prepararlo (entre otros: Transformers.js y el modelo SigLIP 2, Apache 2.0; sharp, Apache 2.0; ExifTool; ag-psd, MIT; heic-decode, ISC).
