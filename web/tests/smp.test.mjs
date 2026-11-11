// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../pkg/cbor.js';
import { Smp, Deframer, frame, packet, crc16, GROUP } from '../pkg/smp.js';

test('cbor round trip', () => {
	const v = { a: 1, b: -500, c: 'txt', d: Uint8Array.of(1, 2), e: [true, false, null], f: 70000 };
	assert.deepEqual(decode(encode(v)), v);
});

test('cbor decodes indefinite-length maps, arrays and strings as zcbor emits them', () => {
	/* {_ "images": [_ {_ "slot": 1, "hash": (_ h'0102', h'03')}]} */
	const buf = Uint8Array.of(0xbf, 0x66, ...new TextEncoder().encode('images'), 0x9f, 0xbf,
		0x64, ...new TextEncoder().encode('slot'), 0x01,
		0x64, ...new TextEncoder().encode('hash'), 0x5f, 0x42, 1, 2, 0x41, 3, 0xff,
		0xff, 0xff, 0xff);
	assert.deepEqual(decode(buf), { images: [{ slot: 1, hash: Uint8Array.of(1, 2, 3) }] });
});

test('crc16 matches CRC-16/XMODEM check value', () => {
	assert.equal(crc16(new TextEncoder().encode('123456789')), 0x31c3);
});

test('frames split into 127-byte lines and deframe back', () => {
	const pkt = packet(2, 1, 1, 7, { data: new Uint8Array(200).fill(0xab) });
	const bytes = frame(pkt);
	const lines = new TextDecoder('latin1').decode(bytes).split('\n').filter((l) => l !== '');
	assert.ok(lines.length > 1 && lines.every((l) => l.length <= 126));
	const got = [];
	new Deframer((p) => got.push(p), () => {}).push(bytes);
	assert.deepEqual(got[0], pkt);
});

/** A fake Zephyr device: SMP image upload, list, test, reset and the fuse. */
function fakeDevice({ dropUploads = [] } = {}) {
	const state = { image: [], locked: false, tested: null, resets: 0, uploads: 0 };
	const toHost = new TransformStream();
	const hostWriter = toHost.writable.getWriter();
	const enc = new TextEncoder();
	hostWriter.write(enc.encode('*** Booting Zephyr ***\ncra_boot_demo v1.0.0+0\n'));

	const deframer = new Deframer((pkt) => {
		const op = pkt[0] & 7;
		const group = (pkt[4] << 8) | pkt[5];
		const id = pkt[7];
		const req = decode(pkt.subarray(8));
		let rsp = {};
		if (group === GROUP.IMAGE && id === 1) {
			/* A dropped line: the request never arrives, so there is no answer. */
			if (dropUploads.includes(++state.uploads)) {
				return;
			}
			/* As img_mgmt does: write only the chunk at the expected offset. */
			if (req.off === state.image.length) {
				state.image.push(...req.data);
			}
			rsp = { rc: 0, off: state.image.length };
		} else if (group === GROUP.IMAGE && id === 0 && op === 0) {
			rsp = { images: [{ slot: 1, version: '2.0.0', hash: Uint8Array.of(9, 9) }] };
		} else if (group === GROUP.IMAGE && id === 0) {
			state.tested = req.hash;
		} else if (group === GROUP.OS && id === 5) {
			state.resets++;
		} else if (group === GROUP.FUSE) {
			if (op === 2) {
				state.locked = true;
			}
			rsp = { locked: state.locked };
		}
		hostWriter.write(enc.encode('log line in between\n'));
		hostWriter.write(frame(packet(op + 1, group, id, pkt[6], rsp)));
	}, () => {});

	const writable = new WritableStream({ write(chunk) { deframer.push(chunk); } });
	return { state, port: { readable: toHost.readable, writable } };
}

test('upload, test, reset and fuse against a fake device', async () => {
	const { state, port } = fakeDevice();
	const logs = [];
	const smp = new Smp(port, (l) => logs.push(l));
	const image = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);

	await smp.upload(image);
	assert.deepEqual(Uint8Array.from(state.image), image);

	const list = await smp.imageList();
	await smp.imageTest(list.images[0].hash);
	assert.deepEqual(state.tested, Uint8Array.of(9, 9));

	assert.equal((await smp.fuseState()).locked, false);
	assert.equal((await smp.fuseLock()).locked, true);

	await smp.reset();
	assert.equal(state.resets, 1);
	assert.ok(logs.includes('cra_boot_demo v1.0.0+0'));
	await smp.close();
});

test('upload asks again when the device drops a chunk', async () => {
	const { state, port } = fakeDevice({ dropUploads: [3, 4, 7] });
	const smp = new Smp(port);
	smp.chunkTimeoutMs = 30;
	const retries = [];
	smp.onRetry = (off, n) => retries.push([off, n]);
	const image = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);

	await smp.upload(image);
	assert.deepEqual(Uint8Array.from(state.image), image);
	assert.deepEqual(retries, [[256, 1], [256, 2], [512, 1]]);
	await smp.close();
});

test('upload gives up after repeated silence', async () => {
	const { port } = fakeDevice({ dropUploads: [2, 3, 4, 5, 6, 7] });
	const smp = new Smp(port);
	smp.chunkTimeoutMs = 20;
	await assert.rejects(smp.upload(new Uint8Array(1000)), /no SMP response \(group 1, id 1\)/);
	await smp.close();
});
