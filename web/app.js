// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0

import { parseHex } from './pkg/hex.js';
import { Dap, HidTransport } from './pkg/dap.js';
import { parseFlm, FlashAlgo } from './pkg/flash_flm.js';
import { park, run } from './pkg/pic32ck.js';
import { Smp } from './pkg/smp.js';

/* Hardware facts; firmware files come from manifest.json. */
const BOARD = {
	id: 'pic32ck_sg01_cnano',
	/* The nEDBG serves CMSIS-DAP and the virtual COM port on one USB device. */
	probeFilters: [{ vendorId: 0x03eb, productId: 0x2175 }],
	serialFilters: [{ usbVendorId: 0x03eb, usbProductId: 0x2175 }],
	/*
	 * MCUboot state outside the image it is flashed with: slot 1's header and
	 * the swap trailers, the last 8 KB of each slot (slot0 0x0c000000 and
	 * slot1 0x0c0fc000, 0xfc000 each, in the board dts). Flashing a bootloader
	 * erases these, so a pending or half-done swap cannot carry over.
	 */
	bootState: [0x0c0fa000, 0x0c0fb000, 0x0c0fc000, 0x0c1f6000, 0x0c1f7000],
};

/* Bootloader builds; each MCUboot file also carries the firmware release it shipped with. */
const BOOTS = {
	none: { t: 'none (plain blinky)', file: 'blinky.hex' },
	hash: { t: 'MCUboot, hash only', file: 'provision_hash.hex' },
	signed: { t: 'MCUboot, signature', file: 'provision_signed.hex' },
	rollback: { t: 'MCUboot, signature and downgrade prevention', file: 'provision_rollback.hex' },
	attacker: { t: 'the attacker\'s', file: 'provision_attacker.hex' },
};

const IMAGES = {
	v2: { t: 'vendor v2.0.0', file: 'app_v2.signed.bin' },
	old: { t: 'vendor v1.1.0', file: 'app_v1.1.signed.bin' },
	forged: { t: 'forged v9.9.9, no signature', file: 'app_forged.unsigned.bin' },
	ownkey: { t: 'v9.9.9 signed with the attacker\'s key', file: 'app_ownkey.signed.bin' },
};

/* Console lines that settle a step, and what they mean. */
const SEEN = {
	v1: { re: /cra_boot_demo v1\.0\.0/, cls: 'ok', text: 'v1.0.0 is running.', stamp: 'Shipped!' },
	v11: { re: /cra_boot_demo v1\.1\.0/, cls: 'ok', text: 'v1.1.0 is running.', stamp: 'Signed!' },
	v2: { re: /cra_boot_demo v2\.0\.0/, cls: 'ok', text: 'v2.0.0 is running.', stamp: 'Patched!' },
	v21: { re: /cra_boot_demo v2\.1\.0/, cls: 'ok', text: 'v2.1.0 is running.', stamp: 'Fixed!' },
	reflashed: { re: /^Got you!/, cls: 'bad', text: 'Attack worked: attacker firmware, written straight to flash.', stamp: 'Wiped!' },
	gotYou: { re: /^Got you!/, cls: 'bad', text: 'Attack worked: the board runs attacker code.', stamp: 'Got you!' },
	downgraded: { re: /cra_boot_demo v1\.1\.0/, cls: 'bad', text: 'Attack worked: the old v1.1.0 is running again.', stamp: 'Rolled back!' },
	unlocked: { re: /^Got you!/, cls: 'bad', text: 'Attack worked: the old factory command answers, and the LED blinks fast.', stamp: 'Unlocked!' },
	invalid: { re: /not valid/, cls: 'ok', text: 'Blocked: MCUboot rejected the image.', stamp: 'Rejected!' },
	older: { re: /downgrade prevention/, cls: 'ok', text: 'Blocked: MCUboot refused the older version.', stamp: 'Too old!' },
	locked: { re: /fuse locked/, cls: 'ok', text: 'Debug port locked.', stamp: 'Locked!' },
};

/*
 * The talk, in order. Each round is an attack and the Zephyr/MCUboot option
 * that stops it. do: flash a bootloader over the debugger, send an image over
 * serial, exploit the v1.0.0 factory command, or lock the debug port.
 * on: the bootloader a serial step assumes. opts: [option, where it lives].
 */
const ROUNDS = [
	{
		title: 'Ship it',
		intro: 'You are the OEM, and the product has one job: blink once a second. Version 1.0.0 leaves the '
			+ 'factory with a bootloader and over-the-air updates (the serial link stands in for them here), '
			+ 'and the update file is on your website.',
		steps: [
			{ id: 'ship', role: 'oem', t: 'Program v1.0.0 at the factory', do: { flash: 'hash' }, seen: 'v1',
				d: 'MCUboot and firmware v1.0.0. MCUboot checks a SHA-256 hash of the image. That catches a '
					+ 'corrupted download and nothing else. After this step the product is in the field: you '
					+ 'can reach it with updates, and with the debugger only by rolling a truck.',
				expect: 'cra_boot_demo v1.0.0+0, blink 1000 ms',
				opts: [['SB_CONFIG_BOOT_SIGNATURE_TYPE_NONE=y', 'build flag for this starting point']] },
		],
	},
	{
		title: 'Round 1: a forged update',
		intro: 'The attacker wants the LED blinking four times too fast. They change the downloaded firmware '
			+ 'and send it back through the product\'s own update path.',
		steps: [
			{ id: 'forge', role: 'attacker', t: 'Send a forged update', do: { send: 'forged' }, on: 'hash', seen: 'gotYou',
				d: 'Blinks every 250 ms, claims to be version 9.9.9 and was built with no key at all. Anyone can '
					+ 'compute the hash.',
				expect: 'cra_boot_demo v9.9.9+0, blink 250 ms … Got you! forged image, no signature' },
			{ id: 'sign', role: 'oem', t: 'Roll a truck: reflash v1.1.0 with a signature check', do: { flash: 'signed' }, seen: 'v11',
				truck: true,
				d: 'No update can deliver this fix. The check belongs in MCUboot, and an update only replaces the '
					+ 'application, so someone has to go to every unit. MCUboot now holds the public half of '
					+ 'the vendor key and boots only images signed with the private half, on every boot.',
				expect: 'cra_boot_demo v1.1.0+0, blink 1000 ms',
				opts: [
					['SB_CONFIG_BOOT_SIGNATURE_TYPE_ECDSA_P256=y', 'app/sysbuild.conf'],
					['SB_CONFIG_BOOT_SIGNATURE_KEY_FILE', 'your key; the default is a public test key'],
					['CONFIG_BOOT_VALIDATE_SLOT0=y', 'app/sysbuild/mcuboot.conf'],
				] },
			{ id: 'forge2', role: 'attacker', t: 'Send the forged update again', do: { send: 'forged' }, on: 'signed',
				seen: 'invalid', d: 'Same file as before. The hash is still correct; there is no signature to check.',
				expect: 'Image in the secondary slot is not valid!' },
			{ id: 'ownkey', role: 'attacker', t: 'Sign it with your own key', do: { send: 'ownkey' }, on: 'signed',
				seen: 'invalid', optional: true,
				d: 'A real ECDSA P-256 signature, from a key MCUboot has never heard of.',
				expect: 'Image in the secondary slot is not valid!' },
		],
	},
	{
		title: 'Round 2: rollback',
		intro: 'Version 1.1.0 turns out to have a leftover factory test command that speeds up the blink and '
			+ 'reopens the debug port. The OEM ships 2.0.0 without it. The attacker kept the 1.1.0 file, and its signature is genuine.',
		steps: [
			{ id: 'v2', role: 'oem', t: 'Release v2.0.0 over the air: remove the factory command', do: { send: 'v2' }, on: 'signed',
				seen: 'v2', d: 'A bug in the application, so this one can be fixed in the field. The update is signed by '
					+ 'the vendor and MCUboot swaps it in.',
				expect: 'cra_boot_demo v2.0.0+0, blink 1000 ms' },
			{ id: 'replay', role: 'attacker', t: 'Send the old v1.1.0 back', do: { send: 'old' }, on: 'signed',
				seen: 'downgraded', d: 'It blinks correctly and its signature is valid. A signature says who made the image, not whether it is current.',
				expect: 'cra_boot_demo v1.1.0+0, blink 1000 ms' },
			{ id: 'hole', role: 'attacker', t: 'Use the v1.1.0 factory command', do: { exploit: true }, seen: 'unlocked',
				d: 'The bug the update fixed is back, so the attacker uses it. Watch the LED.',
				expect: 'Got you! v1.1.0+0 factory command: blink 250 ms, debug lock cleared' },
			{ id: 'rollback', role: 'oem', t: 'Roll another truck: reflash v2.1.0, refusing older versions', truck: true,
				do: { flash: 'rollback' },
				seen: 'v21', d: 'One more bootloader option that v1.1.0 shipped without, so one more truck. MCUboot '
					+ 'now compares the version in the image header with the one that is running and erases an '
					+ 'update that is not newer.',
				expect: 'cra_boot_demo v2.1.0+0, blink 1000 ms',
				opts: [['CONFIG_MCUBOOT_DOWNGRADE_PREVENTION=y', 'app/sysbuild/mcuboot_downgrade.conf']] },
			{ id: 'replay2', role: 'attacker', t: 'Send the old v1.1.0 back again', do: { send: 'old' }, on: 'rollback',
				seen: 'older', d: 'Still genuinely signed. No longer enough.',
				expect: 'Image 0 in slot 1 erased due to downgrade prevention' },
		],
	},
	{
		title: 'Round 3: the debug port',
		intro: 'Every check so far lives in flash. An attacker holding the board can rewrite flash through '
			+ 'the debug port, with the same tool the factory uses.',
		steps: [
			{ id: 'reflash', role: 'attacker', t: 'Rewrite flash over the debugger', do: { flash: 'attacker' },
				seen: 'reflashed', d: 'Writes the forged firmware from round 1 and a bootloader that accepts it. '
					+ 'Signature and version checks are gone, and the LED blinks fast again.',
				expect: 'cra_boot_demo v9.9.9+0, blink 250 ms … Got you! forged image, no signature' },
			{ id: 'restore', role: 'oem', t: 'Roll a third truck: reflash v2.1.0', do: { flash: 'rollback' }, seen: 'v21', truck: true,
				d: 'The same build as the round 2 fix.',
				expect: 'cra_boot_demo v2.1.0+0, blink 1000 ms' },
			{ id: 'lock', role: 'oem', t: 'Lock the debug port', do: { lock: true }, seen: 'locked',
				d: 'This should have happened before v1.0.0 left the factory. On a production PIC32CK it is the '
					+ 'debug access level. Here a marker in flash stands in for it and this page honors it, so '
					+ 'the board stays reusable.',
				expect: 'cra_boot_demo v2.1.0+0, blink 1000 ms, fuse locked',
				opts: [['app/src/fuse.c', 'the simulated lock']] },
			{ id: 'reflash2', role: 'attacker', t: 'Try the debugger again', do: { flash: 'attacker' }, refusal: true,
				d: 'The same attack as the first step of this round.',
				expectText: 'This page refuses to flash while the lock is set.' },
		],
	},
];

const RESET = [
	{ id: 'erase', role: 'neutral', t: 'Erase the chip', do: { erase: true },
		d: 'Clears boot flash and program flash, the debug lock included. The board is empty afterward: '
			+ 'start again at step 1.' },
	{ id: 'blinky', role: 'neutral', t: 'Flash a plain blinky', do: { flash: 'none' },
		d: 'Zephyr\'s blinky sample with no bootloader, to leave the board in a neutral state.' },
];

const ROLE = { oem: 'OEM', attacker: 'Attacker', neutral: '' };

const BOOT_KEY = 'cra-boot-demo.boot';
const MGMT_ERR_ENOTSUP = 8;

const $ = (id) => document.getElementById(id);
const state = {
	manifest: null, smp: null, port: null, probe: false, locked: null, logs: [], busy: false,
	boot: null, running: null, watch: null, focus: null, active: null, expandAll: false, trucks: 0,
	opening: false,
};

function log(msg, el = 'activity') {
	const line = `${new Date().toLocaleTimeString()}  ${msg}`;
	state.logs.push(`[${el}] ${line}`);
	/* One log: what the board prints, and dimmed, what this page does to it. */
	const pre = $('console');
	const row = document.createElement('div');
	if (el === 'console') {
		row.className = /^Got you!/.test(msg) ? 'bad'
			: /not valid|downgrade prevention/.test(msg) ? 'ok'
			: /cra_boot_demo v/.test(msg) ? 'banner' : '';
		row.textContent = msg || '\u00a0';
	} else {
		row.className = 'page';
		row.textContent = `> ${msg}`;
	}
	pre.append(row);
	pre.scrollTop = pre.scrollHeight;
}

function progress(phase, frac) {
	$('progress').hidden = frac === null;
	$('bar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
	$('phase').textContent = phase ? `${phase} ${Math.round((frac ?? 0) * 100)}%` : '';
}

async function fetchFile(name) {
	const entry = state.manifest.boards[BOARD.id].files[name];
	if (entry === undefined) {
		throw new Error(`${name} is not in this release`);
	}
	const buf = new Uint8Array(await (await fetch(entry.path, { cache: 'no-cache' })).arrayBuffer());
	const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
		.map((b) => b.toString(16).padStart(2, '0')).join('');
	if (sum !== entry.sha256) {
		throw new Error(`${name}: checksum mismatch, refusing to use it`);
	}
	return buf;
}

/*
 * The browser refuses a device that another tab or program holds open; say
 * so instead of passing on its generic message.
 */
function inUse(what, e) {
	return new Error(`${what} is in use by another browser tab or program. Disconnect it or close `
		+ `that tab, then try again. (${e.message})`);
}

/*
 * The browser cannot tell which serial port belongs to which debugger, so
 * with two boards attached a step could flash one and listen to the other.
 */
const ONE_BOARD = 'More than one board is plugged in. Unplug all but one, then try again.';

/* ---------- serial / SMP ---------- */

/*
 * Open the board's serial port. A port the user allowed before opens without
 * asking, so plugging the board in is enough; `ask` shows the browser's
 * chooser when there is none, and needs a click.
 */
async function connectSerial(ask) {
	/* Plugging in fires a serial and a debugger event at once; only one of them may open the port. */
	if (state.smp !== null || state.opening) {
		return;
	}
	state.opening = true;
	try {
		const known = (await navigator.serial.getPorts()).filter((p) => {
			const i = p.getInfo();
			return BOARD.serialFilters.some((f) => f.usbVendorId === i.usbVendorId && f.usbProductId === i.usbProductId);
		});
		if (known.length > 1) {
			throw new Error(ONE_BOARD);
		}
		if (known.length === 0 && !ask) {
			return;
		}
		const port = known[0] ?? await navigator.serial.requestPort({ filters: BOARD.serialFilters });
		try {
			await port.open({ baudRate: 115200 });
		} catch (e) {
			throw inUse('The serial port', e);
		}
		state.port = port;
		state.smp = new Smp(port, (line) => {
			log(line, 'console');
			watchConsole(line);
		});
		state.smp.onRetry = (off, n) => log(`No answer at offset ${off}, asking again (retry ${n})`);
		$('serial-dot').className = 'dot ok';
		$('serial-state').textContent = 'Connected';
		port.addEventListener('disconnect', () => dropSerial());
	} finally {
		state.opening = false;
	}
	render();
	await checkFuse();
}

async function dropSerial(reason = 'Not connected') {
	const { smp, port } = state;
	state.smp = null;
	state.port = null;
	await smp?.close().catch(() => {});
	await port?.close().catch(() => {});
	$('serial-dot').className = 'dot';
	$('serial-state').textContent = reason;
	state.running = null;
	setFuse(null);
}

function setFuse(locked, text) {
	state.locked = locked;
	$('fuse-dot').className = `dot ${locked === true ? 'bad' : locked === false ? 'ok' : ''}`;
	$('fuse-state').textContent = text ?? (locked === true ? 'locked' : locked === false ? 'open' : 'unknown');
	render();
}

async function checkFuse() {
	if (state.smp === null) {
		setFuse(null);
		return null;
	}
	try {
		const { locked } = await state.smp.fuseState();
		setFuse(locked);
		return locked;
	} catch {
		setFuse(null, 'no answer');
		return null;
	}
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function update(img) {
	if (state.smp === null) {
		throw new Error('Connect serial first');
	}
	const image = await fetchFile(img.file);
	log(`Uploading ${img.file} (${image.length} bytes) to slot1`);
	await state.smp.upload(image, (f) => progress('upload', f));
	const { images } = await state.smp.imageList();
	const slot1 = images.find((i) => i.slot === 1);
	if (slot1 === undefined) {
		throw new Error('device reports no image in slot1');
	}
	/* MCUmgr will not mark the running image for test, so MCUboot never sees it. */
	const active = images.find((i) => i.active);
	if (active && sameBytes(active.hash, slot1.hash)) {
		throw new Error(`refused by the running firmware: v${slot1.version} is already running. Send a different image first.`);
	}
	log(`slot1 holds version ${slot1.version}; marking it for test and resetting`);
	await state.smp.imageTest(slot1.hash);
	await state.smp.reset();
	log('Watch the device console: MCUboot decides now');
}

/* ---------- debugger ---------- */

const isProbe = (d) => BOARD.probeFilters.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);

/* The browser lists a probe only once the user has allowed it and while it is plugged in. */
async function updateProbe() {
	state.probe = (await navigator.hid.getDevices()).some(isProbe);
	$('probe-dot').className = `dot ${state.probe ? 'ok' : ''}`;
	$('probe-state').textContent = state.probe ? 'Ready' : 'Not connected';
	render();
}

/* Both links up. Every step needs this, so nothing is flashed without its console showing. */
const boardReady = () => state.smp !== null && state.probe;

/* Bring up whatever the browser already has permission for; never asks. */
async function autoConnect() {
	if ('hid' in navigator) {
		await updateProbe();
	}
	if ('serial' in navigator) {
		await connectSerial(false).catch((e) => log(`Error: ${e.message}`));
	}
}

/* The Connect board button: ask for whichever link the browser has not been allowed yet. */
async function connectBoard() {
	try {
		await connectSerial(true);
		if (!state.probe) {
			await navigator.hid.requestDevice({ filters: BOARD.probeFilters });
			await updateProbe();
		}
	} catch (e) {
		/* Closing a chooser is not an error worth showing. */
		if (e.name !== 'NotFoundError' && e.name !== 'AbortError') {
			log(`Error: ${e.message}`);
		}
	}
	render();
}

async function openProbe() {
	if (!('hid' in navigator)) {
		throw new Error('This browser has no WebHID. Use Chrome or Edge.');
	}
	const connected = (await navigator.hid.getDevices()).filter(isProbe);
	if (connected.length > 1) {
		throw new Error(ONE_BOARD);
	}
	const device = connected[0] ?? (await navigator.hid.requestDevice({ filters: BOARD.probeFilters }))[0];
	if (device === undefined) {
		throw new Error('No debugger selected');
	}
	return new Dap(new HidTransport(device));
}

async function loadFlms() {
	return Promise.all(state.manifest.boards[BOARD.id].flm.map(async (f) => {
		const elf = await fetchFile(f);
		return parseFlm(elf);
	}));
}

async function withProbe(fn) {
	const dap = await openProbe();
	try {
		await dap.connect();
	} catch (e) {
		/* DOMExceptions from open()/claimInterface(); our own errors stay as they are. */
		if (e.probeOpen && e instanceof DOMException) {
			throw inUse('The debugger', e);
		}
		throw e;
	}
	log(`Debugger connected, DPIDR 0x${dap.dpidr.toString(16)}`);
	try {
		/* Through the boot ROM, so this works whatever is in flash, a blank chip included. */
		await park(dap);
		return await fn(dap);
	} finally {
		await dap.disconnect();
	}
}

/* Program segments; first erase the sectors starting at the erase addresses. */
async function flashSegments(segments, erase = []) {
	await withProbe(async (dap) => {
		for (const flm of await loadFlms()) {
			const algo = new FlashAlgo(dap, flm);
			const tag = (phase, f) => progress(`${flm.device.name} ${phase}`, f);
			await algo.install();
			await algo.eraseSectors(erase, tag);
			log(`Programming ${flm.device.name} with the Microchip flash algorithm`);
			await algo.program(segments, tag);
		}
		await run(dap);
	});
	log('Flash done, target reset');
}

async function resetBoard() {
	await withProbe((dap) => run(dap));
	log('Target reset');
}

async function eraseChip() {
	await withProbe(async (dap) => {
		for (const flm of await loadFlms()) {
			const algo = new FlashAlgo(dap, flm);
			await algo.install();
			log(`Erasing ${flm.device.name}`);
			await algo.eraseAll((phase, f) => progress(`${flm.device.name} ${phase}`, f));
		}
	});
	log('Chip erased');
}

async function refuseIfLocked() {
	const locked = state.smp ? await checkFuse() : state.locked;
	if (locked === true) {
		throw new Error('Fuse is locked: the debug port is refused. Erase the chip to recover.');
	}
}

async function flashFile(name, erase = []) {
	await refuseIfLocked();
	const text = new TextDecoder().decode(await fetchFile(name));
	await flashSegments(parseHex(text), erase);
}

/* ---------- demo actions ---------- */

const results = new Map();

/* The bootloader this page last flashed; the board cannot report it. */
function rememberBoot(id) {
	state.boot = id;
	try {
		if (id === null) {
			localStorage.removeItem(BOOT_KEY);
		} else {
			localStorage.setItem(BOOT_KEY, id);
		}
	} catch { /* storage blocked: the page forgets on reload */ }
}

/* Follow what the board runs, and settle the step that is waiting on a console line. */
function watchConsole(line) {
	const m = /cra_boot_demo v(\S+), blink/.exec(line);
	const w = state.watch;
	const settled = w !== null && SEEN[w.seen].re.test(line);
	if (m) {
		state.running = { version: m[1], gotYou: false };
	} else if (/^Got you!/.test(line) && state.running) {
		state.running.gotYou = true;
	} else if (!settled) {
		return;
	}
	if (settled) {
		results.set(w.id, { cls: SEEN[w.seen].cls, text: SEEN[w.seen].text, done: true });
		state.watch = null;
		celebrate(SEEN[w.seen].cls === 'bad' ? 'villain' : 'hero', SEEN[w.seen].stamp);
		advance(w.id);
		return;
	}
	render();
}

async function runStep(step) {
	const { flash, send, exploit, lock, erase } = step.do;
	if (flash) {
		await flashFile(BOOTS[flash].file, flash === 'none' ? [] : BOARD.bootState);
		rememberBoot(flash);
	} else if (send) {
		await update(IMAGES[send]);
	} else if (exploit) {
		if (state.smp === null) {
			throw new Error('Connect serial first');
		}
		try {
			await state.smp.factoryUnlock();
		} catch (e) {
			if (e.rc === MGMT_ERR_ENOTSUP) {
				throw new Error('refused by the running firmware: this version has no factory command.');
			}
			throw e;
		}
		await checkFuse();
	} else if (lock) {
		if (state.smp === null) {
			throw new Error('Connect serial first');
		}
		await state.smp.fuseLock();
		await checkFuse();
		await state.smp.reset();
	} else if (erase) {
		await eraseChip();
		rememberBoot(null);
		state.running = null;
		setFuse(false, 'open');
	}
}

async function act(step) {
	state.busy = true;
	state.active = step.id;
	state.watch = step.seen ? { id: step.id, seen: step.seen } : null;
	results.delete(step.id);
	if (step.truck && !missingLink()) {
		truckRoll();
	}
	render();
	log(step.t);
	try {
		await runStep(step);
		if (step.refusal) {
			results.set(step.id, { cls: 'bad', text: 'The debugger was not refused. Lock the debug port first.' });
		} else if (!results.has(step.id)) {
			results.set(step.id, { cls: '', done: !step.seen,
				text: step.seen ? `${step.do.flash ? 'Flashed' : 'Sent'}. Watch the board console.` : 'Done.' });
		}
	} catch (e) {
		state.watch = null;
		if (step.refusal && /Fuse is locked/.test(e.message)) {
			results.set(step.id, { cls: 'ok', text: 'Blocked: the debug port is locked.', done: true });
			celebrate('hero', 'Locked out!');
		} else {
			results.set(step.id, { cls: /refused/.test(e.message) ? 'warn' : 'bad', text: e.message });
		}
		log(`Error: ${e.message}`);
	} finally {
		progress(null, null);
		state.busy = false;
		state.active = null;
		if (results.get(step.id)?.done) {
			advance(step.id);
		} else {
			render();
		}
	}
}

/* ---------- rendering ---------- */

/* A file of the commit this site was built from; null for a local build. */
function source(path = '') {
	const { repo, commit } = state.manifest ?? {};
	return repo ? `${repo}/blob/${commit}/${path}` : null;
}

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) {
		e.className = cls;
	}
	if (text !== undefined) {
		e.textContent = text;
	}
	return e;
}

function optList(opts) {
	const ul = el('ul', 'opts');
	for (const [name, where] of opts) {
		const li = el('li');
		const file = [name, where].find((p) => p.startsWith('app/'));
		const code = el('code', '', name);
		if (file && source()) {
			const a = el('a');
			a.href = source(file);
			a.target = '_blank';
			a.rel = 'noopener';
			a.append(code);
			li.append(a);
		} else {
			li.append(code);
		}
		li.append(el('span', '', `  ${where}`));
		ul.append(li);
	}
	return ul;
}

const sequence = () => ROUNDS.flatMap((round) => round.steps);

/* The move in play: the one the user opened, else the first that is not settled. */
function currentId() {
	return state.focus ?? sequence().find((s) => !results.get(s.id)?.done)?.id ?? null;
}

/* A move settled: open the next one and bring it into view. */
function advance(id) {
	const seq = sequence();
	const i = seq.findIndex((s) => s.id === id);
	const wasCurrent = currentId() === id || state.focus === null;
	if (i >= 0 && wasCurrent) {
		state.focus = seq[i + 1]?.id ?? null;
	}
	render();
	if (i >= 0 && wasCurrent && state.focus && !state.expandAll) {
		document.getElementById(`step-${state.focus}`)?.scrollIntoView({ block: 'center' });
	}
}

const VERB = {
	flash: ['Flash over the debugger', 'Flashing…'],
	factory: ['Flash at the factory', 'Flashing…'],
	send: ['Send as an update', 'Sending…'],
	exploit: ['Send the command', 'Sending…'],
	lock: ['Lock the debug port', 'Locking…'],
	erase: ['Erase the chip', 'Erasing…'],
};

/* True when a step cannot run because the board is not fully connected. */
function missingLink() {
	return !boardReady();
}

/* The button for a step, with the reason when it cannot be pressed yet. */
function action(step) {
	const kind = Object.keys(step.do)[0];
	const missing = missingLink();
	const go = el('div', 'go');
	/* The OEM's debugger is the factory's programmer; the attacker's is a probe on a bench. */
	const verb = VERB[kind === 'flash' && step.role === 'oem' ? 'factory' : kind];
	const b = el('button', 'act', verb[state.active === step.id ? 1 : 0]);
	b.type = 'button';
	b.disabled = state.busy || state.manifest === null || missing;
	b.addEventListener('click', () => act(step));
	go.append(b);
	if (missing) {
		go.append(el('span', '', 'Connect the board in the bar below first.'));
	}
	return go;
}

function details(step, r) {
	const body = el('div', 'body');
	body.append(el('p', 'd', step.d));
	if (step.expect) {
		const e = el('div', 'prints', 'The board prints');
		e.append(el('code', '', step.expect));
		body.append(e);
	} else if (step.expectText) {
		body.append(el('div', 'prints', step.expectText));
	}
	if (step.opts) {
		body.append(optList(step.opts));
	}
	if (step.on && state.boot && state.boot !== step.on) {
		body.append(el('div', 'hint', `Expects "${BOOTS[step.on].t}" on the board; this page last flashed `
			+ `"${BOOTS[state.boot].t}".`));
	}
	body.append(action(step), el('div', `r ${r?.cls ?? ''}`, r?.text ?? ''));
	return body;
}

function moveRow(step, n) {
	const r = results.get(step.id);
	const current = currentId() === step.id;
	const open = current || state.expandAll;
	const li = el('li', `move ${step.role}${open ? ' open' : ''}${current ? ' current' : ''}${r?.done ? ' done' : ''}`);
	li.id = `step-${step.id}`;

	const card = el('div', 'card');
	const head = el('button', 'head');
	head.type = 'button';
	head.setAttribute('aria-expanded', String(open));
	head.append(el('span', 'role', ROLE[step.role]), el('span', 't', `${step.t}${step.optional ? ' (optional)' : ''}`));
	if (!open && r?.text) {
		head.append(el('span', `r ${r.cls}`, r.text));
	}
	head.addEventListener('click', () => {
		state.focus = step.id;
		render();
		document.querySelector(`#step-${step.id} .head`)?.focus();
	});
	card.append(head);
	if (open) {
		card.append(details(step, r));
	}
	li.append(el('span', 'node', String(n)), card);
	return li;
}

function plainRow(step) {
	const r = results.get(step.id);
	const li = el('li');
	const text = el('div');
	text.append(el('div', 't', step.t), el('div', 'd', step.d), el('div', `r ${r?.cls ?? ''}`, r?.text ?? ''));
	li.append(text, action(step));
	return li;
}

function render() {
	let n = 0;
	$('rounds').replaceChildren(...ROUNDS.map((round) => {
		const sec = el('section', 'round');
		const head = el('header');
		head.append(el('h2', '', round.title), el('p', '', round.intro));
		const ol = el('ol', 'moves');
		ol.append(...round.steps.map((s) => moveRow(s, ++n)));
		sec.append(head, ol);
		return sec;
	}));
	$('reset').replaceChildren(...RESET.map(plainRow));

	$('dev-boot').textContent = state.boot ? BOOTS[state.boot].t : 'unknown';
	const run = state.running;
	$('dev-running').textContent = run ? `v${run.version}${run.gotYou ? ', attacker code' : ''}` : 'unknown';
	$('dev-running').className = run?.gotYou ? 'pwned' : '';
	$('fuse-btn').disabled = state.smp === null;
	const ready = boardReady();
	$('connect-btn').hidden = ready;
	$('connect-btn').textContent = state.smp === null && !state.probe ? 'Connect board'
		: state.smp === null ? 'Connect serial' : 'Connect debugger';
	$('reset-btn').hidden = !ready;
	$('reset-btn').disabled = state.busy;
	$('disconnect-btn').hidden = state.smp === null;
	$('disconnect-btn').disabled = state.busy;
	$('trucks').textContent = String(state.trucks);
	$('trucks').parentElement.hidden = state.trucks === 0;
}

/* ---------- a little theater ---------- */

const CAST = {
	hero: ['🛡️', '⭐', '✨', '🦸', '💪', '⭐', '✨'],
	villain: ['😈', '💀', '🔥', '👾', '😈', '💥', '🦹'],
};

/* A 14-point comic starburst as a clip-path. */
const BURST = `polygon(${Array.from({ length: 28 }, (_, i) => {
	const r = i % 2 ? 37 : 50;
	const a = (i / 28) * 2 * Math.PI;
	return `${(50 + r * Math.cos(a)).toFixed(1)}% ${(50 + r * Math.sin(a)).toFixed(1)}%`;
}).join(', ')})`;

/*
 * The payoff when a step settles: a comic stamp and a burst of emoji, blue
 * for a win by the OEM, red (and a shudder) for a win by the attacker. It
 * never takes clicks and removes itself.
 */
function celebrate(side, word) {
	document.querySelector('.fx')?.remove();
	const fx = el('div', `fx ${side}`);
	fx.setAttribute('aria-hidden', 'true');
	const stamp = el('div', 'stamp');
	stamp.style.clipPath = BURST;
	stamp.append(el('span', '', word));
	fx.append(stamp);
	for (let i = 0; i < 22; i++) {
		const bit = el('span', 'bit', CAST[side][i % CAST[side].length]);
		const a = (i / 22) * 2 * Math.PI + Math.random() * 0.5;
		const d = 180 + Math.random() * 260;
		bit.style.setProperty('--x', `${Math.round(Math.cos(a) * d)}px`);
		/* Heroes fly up and out; the villain's lot rain down. */
		bit.style.setProperty('--y', `${Math.round(Math.sin(a) * d * 0.7 + (side === 'hero' ? -90 : 140))}px`);
		bit.style.setProperty('--r', `${Math.round(Math.random() * 540 - 270)}deg`);
		bit.style.setProperty('--t', `${(Math.random() * 0.15).toFixed(2)}s`);
		bit.style.fontSize = `${Math.round(26 + Math.random() * 26)}px`;
		fx.append(bit);
	}
	document.body.append(fx);
	document.body.classList.toggle('shudder', side === 'villain');
	setTimeout(() => {
		fx.remove();
		document.body.classList.remove('shudder');
	}, 2200);
}

/*
 * A bootloader fix cannot go out as an update, so someone drives to the units.
 * The truck crosses the page while the debugger does its work, and the board
 * panel keeps count.
 */
function truckRoll() {
	state.trucks++;
	document.querySelector('.truck')?.remove();
	const fx = el('div', 'truck');
	fx.setAttribute('aria-hidden', 'true');
	const sign = el('div', 'sign');
	sign.append(el('strong', '', `Truck roll #${state.trucks}`),
		el('span', '', 'The bootloader cannot be updated in the field.'));
	const rig = el('div', 'rig');
	rig.append(el('span', 'van', '🚚'), el('span', 'dust', '💨'));
	fx.append(sign, el('div', 'road'), rig);
	document.body.append(fx);
	setTimeout(() => fx.remove(), 4200);
}

/* ---------- board panel height ---------- */

const DOCK_KEY = 'cra-boot-demo.dock';

/* Drag the panel's top edge, or focus it and use the arrow keys. Double-click resets. */
function initDockResize() {
	const grip = $('grip');
	const root = document.documentElement;
	const set = (px) => {
		const h = Math.round(Math.min(Math.max(px, 110), window.innerHeight * 0.8));
		root.style.setProperty('--dock', `${h}px`);
		try {
			localStorage.setItem(DOCK_KEY, String(h));
		} catch { /* storage blocked: the height resets on reload */ }
	};
	const reset = () => {
		root.style.removeProperty('--dock');
		try {
			localStorage.removeItem(DOCK_KEY);
		} catch { /* nothing stored */ }
	};
	const height = () => grip.parentElement.getBoundingClientRect().height;

	try {
		const saved = Number(localStorage.getItem(DOCK_KEY));
		if (saved > 0) {
			set(saved);
		}
	} catch { /* storage blocked */ }

	grip.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		grip.setPointerCapture(e.pointerId);
		document.body.classList.add('dragging');
	});
	grip.addEventListener('pointermove', (e) => {
		if (grip.hasPointerCapture(e.pointerId)) {
			set(window.innerHeight - e.clientY);
		}
	});
	const stop = () => document.body.classList.remove('dragging');
	grip.addEventListener('pointerup', stop);
	grip.addEventListener('pointercancel', stop);
	grip.addEventListener('dblclick', reset);
	grip.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			set(height() + (e.key === 'ArrowUp' ? 24 : -24));
		}
	});
}

/* ---------- local files ---------- */

async function useLocalFile(file) {
	const buf = new Uint8Array(await file.arrayBuffer());
	state.busy = true;
	render();
	try {
		if (file.name.endsWith('.hex')) {
			await refuseIfLocked();
			log(`Flashing local ${file.name}`);
			await flashSegments(parseHex(new TextDecoder().decode(buf)));
		} else {
			if (state.smp === null) {
				throw new Error('Connect serial first');
			}
			log(`Uploading local ${file.name}`);
			await state.smp.upload(buf, (f) => progress('upload', f));
			const slot1 = (await state.smp.imageList()).images.find((im) => im.slot === 1);
			await state.smp.imageTest(slot1.hash);
			await state.smp.reset();
		}
	} catch (e) {
		log(`Error: ${e.message}`);
	} finally {
		progress(null, null);
		state.busy = false;
		render();
	}
}

/* ---------- boot ---------- */

async function init() {
	/* Show the steps at once; buttons enable as the firmware list and devices arrive. */
	render();
	initDockResize();
	const missing = ['serial', 'hid'].filter((k) => !(k in navigator));
	if (missing.length > 0 && !window.isSecureContext) {
		/* Browsers hide both APIs on plain http unless the host is localhost. */
		$('support').textContent = 'This address is not a secure context, so the browser hides WebHID and Web Serial. '
			+ `Open http://localhost:${location.port || 80}${location.pathname} or use https.`;
		$('support').hidden = false;
	} else if (missing.length > 0) {
		$('support').textContent = `This browser lacks ${missing.map((m) => (m === 'hid' ? 'WebHID' : 'Web Serial')).join(' and ')}, `
			+ 'so it cannot reach the board. Use desktop Chrome or Edge, or follow along by reading the steps.';
		$('support').hidden = false;
	}

	try {
		state.manifest = await (await fetch('manifest.json', { cache: 'no-cache' })).json();
	} catch {
		$('release').textContent = 'manifest.json not found: build the site with scripts/build-site.sh.';
		render();
		return;
	}
	$('release').textContent = `Firmware build ${state.manifest.release}, ${state.manifest.commit.slice(0, 12)}`;
	if (source()) {
		$('guide').href = source('README.md');
		$('guide').hidden = false;
	}

	try {
		state.boot = localStorage.getItem(BOOT_KEY);
	} catch { /* storage blocked */ }
	$('connect-btn').addEventListener('click', connectBoard);
	$('disconnect-btn').addEventListener('click', () => dropSerial());
	$('fuse-btn').addEventListener('click', checkFuse);
	/* Plugging a known board in connects it; unplugging drops both links. */
	if ('hid' in navigator) {
		navigator.hid.addEventListener('connect', autoConnect);
		navigator.hid.addEventListener('disconnect', updateProbe);
	}
	if ('serial' in navigator) {
		navigator.serial.addEventListener('connect', autoConnect);
	}
	await autoConnect();
	$('reset-btn').addEventListener('click', async () => {
		state.busy = true;
		render();
		await resetBoard().catch((e) => log(`Error: ${e.message}`));
		state.busy = false;
		render();
	});
	$('expand').addEventListener('change', (e) => {
		state.expandAll = e.target.checked;
		render();
	});
	$('clear-log').addEventListener('click', () => {
		state.logs = [];
		$('console').textContent = '';
	});
	$('save-log').addEventListener('click', () => {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([state.logs.join('\n')], { type: 'text/plain' }));
		a.download = `boot-demo-${Date.now()}.log`;
		a.click();
	});
	const drop = $('drop');
	drop.addEventListener('click', () => $('file').click());
	drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { $('file').click(); } });
	drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
	drop.addEventListener('dragleave', () => drop.classList.remove('over'));
	drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); useLocalFile(e.dataTransfer.files[0]); });
	$('file').addEventListener('change', (e) => useLocalFile(e.target.files[0]));
	render();
}

init();
