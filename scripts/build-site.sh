#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0
#
# Build the firmware, fetch the Microchip flash algorithms the page runs on
# the target, test the web client and assemble the static site in site/.
# Runs inside the devcontainer, locally or in CI.
#
# Env: RELEASE (default "dev"), COMMIT (default git HEAD), REPO (GitHub
# repository URL for the page's source links, default none).
set -euo pipefail

DEMO=$(cd "$(dirname "$0")/.." && pwd)
BOARD=pic32ck_sg01_cnano
DFP_URL=https://packs.download.microchip.com/Microchip.PIC32CK-SG_DFP.1.10.278.atpack

"$DEMO/scripts/setup.sh"
cd "$(dirname "$DEMO")"
# shellcheck disable=SC1091
. .venv/bin/activate

SITE=$DEMO/site
rm -rf "$SITE"
mkdir -p "$SITE/firmware"
cp -r "$DEMO"/web/index.html "$DEMO"/web/app.js "$DEMO"/web/style.css "$DEMO"/web/pkg "$SITE/"

"$DEMO/scripts/build-firmware.sh" "$BOARD" "$SITE/firmware"
mkdir -p "$SITE/firmware/flm" build/dfp
wget -q -O build/dfp/pack.atpack "$DFP_URL"
python3 -c "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); \
[open(sys.argv[2] + '/' + n.split('/')[-1], 'wb').write(z.read(n)) \
for n in ('keil/Flash/PIC32CK_SG_BFM.FLM', 'keil/Flash/PIC32CK_SG_PFM_2048.FLM', 'LICENSE.txt')]" \
	build/dfp/pack.atpack "$SITE/firmware/flm"

node --test "$DEMO"/web/tests/*.mjs

python3 "$DEMO/scripts/gen-manifest.py" "$SITE" \
	--release "${RELEASE:-dev}" \
	--commit "${COMMIT:-$(git -C "$DEMO" rev-parse HEAD 2>/dev/null || echo unknown)}" \
	--repo "${REPO:-}"
echo "site ready in $SITE"
