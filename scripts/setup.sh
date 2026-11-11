#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0
#
# Create the west workspace around this checkout: fetch Zephyr and the modules
# west.yml lists, apply patches/, and install the Zephyr SDK version that
# Zephyr commit declares. Safe to run again.
set -euo pipefail

DEMO=$(cd "$(dirname "$0")/.." && pwd)
WS=$(dirname "$DEMO")
cd "$WS"

[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
pip install -q --upgrade pip west

[ -d .west ] || west init -l "$DEMO"
west update --narrow -o=--depth=1

pip install -q -r zephyr/scripts/requirements-base.txt \
	-r bootloader/mcuboot/scripts/requirements.txt

# Board support the pinned Zephyr commit lacks. 0001 is upstream pull requests
# 120799 and 121278, merged after that commit: drop it when west.yml moves
# past them. 0002 and 0003 are this demo's own: what MCUboot needs on the
# board, and a start-up hang on boards whose 32 kHz crystal does not run.
# Reset first so that running this script twice is not an error.
git -C zephyr reset -q --hard
git -C zephyr clean -qfd boards dts soc
git -C zephyr apply "$DEMO"/patches/*.patch

west sdk install -t arm-zephyr-eabi
