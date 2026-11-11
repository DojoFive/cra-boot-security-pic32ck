// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0
//
// Connecting to a PIC32CK the way its boot ROM expects, following the debug
// sequences in Microchip's PIC32CK-SG device pack (ResetExtension,
// ExitResetExtension, DebugPortStart, DebugCoreStop).
//
// A debugger can attach to this chip while firmware runs, but only then. With
// blank or broken boot flash the boot ROM keeps the processor in reset and
// answers every memory access with a fault, so a board that was erased, or
// whose flashing was cut short, could never be flashed again. Entering through
// the boot ROM works whatever is in flash, so every operation starts here.

import { PIN } from './dap.js';

const DSU = { STATUSA: 0x44000100, STATUSB: 0x44000104, BCC0: 0x44000110, BCC1: 0x44000114 };
const CRSTEXT = 0x300;		/* STATUSA: processor reset is being held for the debugger */
const BREXT = 0x30000;		/* STATUSA: boot ROM is waiting before it starts firmware */
const BCCD1 = 0x2;		/* STATUSB: the boot ROM has written a reply to BCC1 */
const CMD_EXIT = 0x444247aa;	/* to the boot ROM: finish start-up, then wait */
const ROM_INIT_OK = 0x3;
const ROM_BOOT_OK = 0x4;
const DHCSR = 0xe000edf0;
const DBGKEY = 0xa05f0000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function romReply(dap, want, what) {
	const end = Date.now() + 5000;
	let last = null;
	while (Date.now() < end) {
		if ((await dap.read32(DSU.STATUSB)) & BCCD1) {
			last = await dap.read32(DSU.BCC1);
			if (last === want) {
				return;
			}
		}
		await sleep(5);
	}
	throw new Error(`boot ROM did not report ${what}${last === null ? '' : ` (last reply 0x${last.toString(16)})`}`);
}

/**
 * Reset the chip and stop it inside the boot ROM, before any firmware runs,
 * with the processor halted. On return memory and flash can be accessed and
 * a flash algorithm can run.
 */
export async function park(dap) {
	/* Reset with SWCLK held low: the boot ROM then holds the processor for the debugger. */
	await dap.swjPins(0, PIN.NRESET, 1000);
	for (const level of [0, PIN.SWCLK, 0, PIN.SWCLK, 0, PIN.SWCLK, 0]) {
		await dap.swjPins(level, PIN.SWCLK, 100);
	}
	await dap.swjPins(PIN.NRESET, PIN.NRESET, 1000);
	await dap.dpInit();

	if (((await dap.read32(DSU.STATUSA)) & CRSTEXT) === 0) {
		throw new Error('the chip did not wait for the debugger after reset');
	}
	await dap.write32(DSU.STATUSA, CRSTEXT);
	await romReply(dap, ROM_INIT_OK, 'its start-up check');
	await dap.write32(DSU.BCC0, CMD_EXIT);
	await romReply(dap, ROM_BOOT_OK, 'that it is ready');
	await dap.halt();
}

/** Reset the chip and let its firmware run with the debugger detached from the processor. */
export async function run(dap) {
	await park(dap);
	await dap.write32(DSU.STATUSA, BREXT);
	await dap.write32(DHCSR, DBGKEY);
}
