#!/bin/sh
# dsh-portable — install a .dshpkg without opening DSH.
#
#   ./install.sh preview ~/backup/desktop.dshpkg
#   ./install.sh install  ~/backup/desktop.dshpkg --yes
#
# Every argument is forwarded to bootstrap.mjs, so --home / --profile /
# --mode / --yes / --keep all work here too.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

if [ -n "$(printenv DSH_NODE || true)" ] && [ -x "$(printenv DSH_NODE)" ]; then
  node_bin=$(printenv DSH_NODE)
elif command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
else
  echo "Node.js 22 or newer was not found. Install Node.js, or set DSH_NODE to the node binary shipped with DSH." >&2
  exit 1
fi

if [ ! -f "$here/bootstrap.mjs" ]; then
  echo "bootstrap.mjs is missing next to this script ($here/bootstrap.mjs)." >&2
  exit 1
fi

exec "$node_bin" "$here/bootstrap.mjs" "$@"
