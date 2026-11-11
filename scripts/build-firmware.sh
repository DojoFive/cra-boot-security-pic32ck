#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
# SPDX-License-Identifier: Apache-2.0
#
# Build every image the demo page serves and collect them in <out>/<board>/.
# Each bootloader change ships with its own firmware release:
#   provision_hash.hex       v1.0.0, MCUboot checking only the image hash
#   provision_signed.hex     v1.1.0, MCUboot checking the ECDSA signature
#   provision_rollback.hex   v2.1.0, signature and downgrade prevention
#   app_v2.signed.bin        v2.0.0 update: factory unlock hole removed
#   app_v1.1.signed.bin      v1.1.0 again, for the attacker to replay
#   app_forged.unsigned.bin  attacker v9.9.9: valid hash, no signature
#   app_ownkey.signed.bin    attacker v9.9.9: signed with a freshly generated key
#   provision_attacker.hex   the forged v9.9.9 with a hash-only MCUboot, for the debugger
#   blinky.hex               Zephyr's samples/basic/blinky, no bootloader
#
# Every vendor release blinks once a second; the attacker's images blink at
# 250 ms. v1.x has the factory command hole, v2.x does not.
#
# Usage: build-firmware.sh <board> <out-dir>   (after scripts/setup.sh)
set -euo pipefail

DEMO=$(cd "$(dirname "$0")/.." && pwd)
BOARD=$1
OUT=$(realpath -m "$2")/$BOARD
cd "$(dirname "$DEMO")"
APP=$DEMO/app
KEY=bootloader/mcuboot/root-ec-p256.pem
BUILD=build/$BOARD
IMGTOOL="python3 bootloader/mcuboot/scripts/imgtool.py"

mkdir -p "$OUT"

west build -p -b "$BOARD" -d "$BUILD/blinky" zephyr/samples/basic/blinky
cp "$BUILD/blinky/zephyr/zephyr.hex" "$OUT/blinky.hex"

# Kconfig drops options with unmet dependencies with only a warning; the demo
# is meaningless without these, so fail the build instead.
require() {
	for opt in "${@:2}"; do
		if ! grep -qx "CONFIG_$opt=y" "$1/zephyr/.config"; then
			echo "missing CONFIG_$opt in $1" >&2
			exit 1
		fi
	done
}
refuse() {
	for opt in "${@:2}"; do
		if grep -qx "CONFIG_$opt=y" "$1/zephyr/.config"; then
			echo "unexpected CONFIG_$opt in $1" >&2
			exit 1
		fi
	done
}

release() {	# release <version>: app options for a vendor release
	echo "-Dapp_CONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION=\"$1+0\""
	case $1 in
	2.*) echo -Dapp_CONFIG_DEMO_FACTORY_UNLOCK=n ;;
	esac
}
provision() {	# provision <build>: MCUboot and the application as one file
	python3 zephyr/scripts/build/mergehex.py -o "$OUT/provision_$1.hex" \
		"$BUILD/$1/mcuboot/zephyr/zephyr.hex" "$BUILD/$1/app/zephyr/zephyr.signed.hex"
}

# v1.0.0 as shipped: MCUboot checks only the hash. No signature, no version check.
# shellcheck disable=SC2046
west build -p --sysbuild -b "$BOARD" -d "$BUILD/hash" "$APP" -- \
	-DSB_CONFIG_BOOT_SIGNATURE_TYPE_NONE=y \
	-DSB_CONFIG_DEMO_DOWNGRADE_PREVENTION=n $(release 1.0.0)
require "$BUILD/hash/mcuboot" BOOT_SWAP_USING_MOVE BOOT_SIGNATURE_TYPE_NONE BOOT_VALIDATE_SLOT0
refuse "$BUILD/hash/mcuboot" MCUBOOT_DOWNGRADE_PREVENTION
require "$BUILD/hash/app" BOOTLOADER_MCUBOOT UART_MCUMGR MCUMGR_TRANSPORT_UART \
	MCUMGR_GRP_IMG MCUMGR_GRP_OS IMG_MANAGER DEMO_FACTORY_UNLOCK
grep -qx "CONFIG_UART_MCUMGR_RX_BUF_COUNT=4" "$BUILD/hash/app/zephyr/.config"
provision hash

# v1.1.0, the round 1 fix: MCUboot checks the signature.
# shellcheck disable=SC2046
west build -p --sysbuild -b "$BOARD" -d "$BUILD/signed" "$APP" -- \
	-DSB_CONFIG_DEMO_DOWNGRADE_PREVENTION=n $(release 1.1.0)
require "$BUILD/signed/mcuboot" BOOT_SWAP_USING_MOVE BOOT_SIGNATURE_TYPE_ECDSA_P256 BOOT_VALIDATE_SLOT0
refuse "$BUILD/signed/mcuboot" MCUBOOT_DOWNGRADE_PREVENTION
require "$BUILD/signed/app" DEMO_FACTORY_UNLOCK
provision signed
cp "$BUILD/signed/app/zephyr/zephyr.signed.bin" "$OUT/app_v1.1.signed.bin"

# v2.0.0, an ordinary update: the factory unlock hole is gone.
# shellcheck disable=SC2046
west build -p --sysbuild -b "$BOARD" -d "$BUILD/v2" "$APP" -- $(release 2.0.0)
refuse "$BUILD/v2/app" DEMO_FACTORY_UNLOCK
cp "$BUILD/v2/app/zephyr/zephyr.signed.bin" "$OUT/app_v2.signed.bin"

# v2.1.0, the round 2 fix: signature and downgrade prevention (the defaults).
# shellcheck disable=SC2046
west build -p --sysbuild -b "$BOARD" -d "$BUILD/rollback" "$APP" -- $(release 2.1.0)
require "$BUILD/rollback/mcuboot" BOOT_SWAP_USING_MOVE BOOT_SIGNATURE_TYPE_ECDSA_P256 \
	BOOT_VALIDATE_SLOT0 MCUBOOT_DOWNGRADE_PREVENTION
refuse "$BUILD/rollback/app" DEMO_FACTORY_UNLOCK
provision rollback

# What an attacker without the vendor key can build. Without a key imgtool
# adds the header and a correct hash; with their own key, a real signature.
west build -p --sysbuild -b "$BOARD" -d "$BUILD/forged" "$APP" -- \
	-DSB_CONFIG_BOOT_SIGNATURE_TYPE_NONE=y \
	-Dapp_EXTRA_CONF_FILE="$APP/attacker/forged.conf"
require "$BUILD/forged/app" MCUBOOT_GENERATE_UNSIGNED_IMAGE
refuse "$BUILD/forged/app" DEMO_FACTORY_UNLOCK
cp "$BUILD/forged/app/zephyr/zephyr.signed.bin" "$OUT/app_forged.unsigned.bin"
# The same image as a debugger would write it, behind the hash-only MCUboot.
python3 zephyr/scripts/build/mergehex.py -o "$OUT/provision_attacker.hex" \
	"$BUILD/hash/mcuboot/zephyr/zephyr.hex" "$BUILD/forged/app/zephyr/zephyr.signed.hex"

ATTACKER_KEY=$PWD/$BUILD/attacker.pem
rm -f "$ATTACKER_KEY"
$IMGTOOL keygen -k "$ATTACKER_KEY" -t ecdsa-p256
west build -p --sysbuild -b "$BOARD" -d "$BUILD/ownkey" "$APP" -- \
	-DSB_CONFIG_BOOT_SIGNATURE_KEY_FILE=\"$ATTACKER_KEY\" \
	-Dapp_EXTRA_CONF_FILE="$APP/attacker/own-key.conf"
refuse "$BUILD/ownkey/app" DEMO_FACTORY_UNLOCK
cp "$BUILD/ownkey/app/zephyr/zephyr.signed.bin" "$OUT/app_ownkey.signed.bin"

for img in app_v1.1.signed app_v2.signed; do
	$IMGTOOL verify -k "$KEY" "$OUT/$img.bin"
done
for img in app_forged.unsigned app_ownkey.signed; do
	if $IMGTOOL verify -k "$KEY" "$OUT/$img.bin" >/dev/null 2>&1; then
		echo "$img.bin verifies against $KEY; it must not" >&2
		exit 1
	fi
done
$IMGTOOL verify "$OUT/app_forged.unsigned.bin"
$IMGTOOL verify -k "$ATTACKER_KEY" "$OUT/app_ownkey.signed.bin"

ls -l "$OUT"
