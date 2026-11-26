#!/bin/sh
# Encuentra Node sin suponer dónde está y corre el buscador. Uso: sh buscar.sh <comando>
AQUI="$(cd "$(dirname "$0")" && pwd)"
for N in "$BUSCAR_NODE" "$HOME/.local/node/bin/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -n "$N" ] && [ -x "$N" ] && "$N" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
    exec "$N" "$AQUI/buscar.cjs" "$@"
  fi
done
echo "No encontré Node 18 o más nuevo. Instalá la versión LTS desde https://nodejs.org y probá de nuevo." >&2
exit 127
