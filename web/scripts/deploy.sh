#!/bin/sh
# Builds the web edition and uploads it to the server behind compositor.fyi (nginx serves /var/www/compositor as is).
# DEPLOY_TARGET overrides where it goes.
set -e
cd "$(dirname "$0")/.."
npm run build
rsync -az --delete dist/ "${DEPLOY_TARGET:-root@compositor.fyi:/var/www/compositor/}"
echo "Deployed to https://compositor.fyi"
