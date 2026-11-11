// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHex } from '../pkg/hex.js';

/* Boot flash (BFM) and program flash (PFM) records, as in provision.hex. */
const HEX = [
	':020000040800F2',
	':0400000000100020CC',
	':020000040C00EE',
	':10000000000102030405060708090A0B0C0D0E0F78',
	':00000001FF',
].join('\n');

test('parseHex merges records and honors extended linear addresses', () => {
	const segs = parseHex(HEX);
	assert.deepEqual(segs.map((s) => [s.addr, s.data.length]), [[0x08000000, 4], [0x0c000000, 16]]);
	assert.equal(segs[1].data[15], 0x0f);
});

test('parseHex rejects a bad checksum', () => {
	assert.throws(() => parseHex(':0100000000FE'), /checksum/);
});
