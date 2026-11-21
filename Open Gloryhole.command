#!/bin/zsh
cd "${0:A:h}" || exit 1
GLORYHOLE_NODE="$(command -v node)"
if [[ -z "$GLORYHOLE_NODE" ]]; then
  GLORYHOLE_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$GLORYHOLE_NODE" ]]; then
  print 'Gloryhole needs Node.js 22 or newer. Install it, then open this launcher again.'
  read '?Press Return to close.'
  exit 1
fi
if [[ ! -x bin/cloudflared ]]; then
  "$GLORYHOLE_NODE" setup.mjs || { read '?Setup failed. Press Return to close.'; exit 1; }
fi
"$GLORYHOLE_NODE" online.mjs --open
read '?Gloryhole has stopped. Press Return to close.'
