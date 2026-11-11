// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse Intel HEX text into contiguous segments.
 * @param {string} text
 * @returns {{addr: number, data: Uint8Array}[]} sorted, merged segments
 */
export function parseHex(text) {
	const bytes = new Map();
	let base = 0;

	for (const [i, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === '') {
			continue;
		}
		if (line[0] !== ':') {
			throw new Error(`hex line ${i + 1}: missing ':'`);
		}
		const rec = Uint8Array.from(line.slice(1).match(/../g), (h) => parseInt(h, 16));
		const sum = rec.reduce((a, b) => (a + b) & 0xff, 0);
		if (sum !== 0) {
			throw new Error(`hex line ${i + 1}: bad checksum`);
		}
		const len = rec[0];
		const off = (rec[1] << 8) | rec[2];
		const type = rec[3];
		const data = rec.subarray(4, 4 + len);

		if (type === 0x00) {
			for (let j = 0; j < len; j++) {
				bytes.set(base + off + j, data[j]);
			}
		} else if (type === 0x01) {
			break;
		} else if (type === 0x02) {
			base = ((data[0] << 8) | data[1]) * 16;
		} else if (type === 0x04) {
			base = ((data[0] << 8) | data[1]) * 0x10000;
		}
		/* 0x03 and 0x05 carry a start address, which flashing ignores. */
	}

	const addrs = [...bytes.keys()].sort((a, b) => a - b);
	const segs = [];
	let start = 0;
	for (let i = 1; i <= addrs.length; i++) {
		if (i === addrs.length || addrs[i] !== addrs[i - 1] + 1) {
			const s = addrs[start];
			segs.push({ addr: s, data: Uint8Array.from(addrs.slice(start, i), (a) => bytes.get(a)) });
			start = i;
		}
	}
	return segs;
}
