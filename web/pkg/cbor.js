// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0
//
// Minimal CBOR (RFC 8949) for MCUmgr SMP payloads: unsigned and negative
// integers, byte and text strings, arrays, maps, booleans and null. Decoding
// also accepts indefinite-length items, which Zephyr's zcbor encoder emits.

function head(out, major, n) {
	if (n < 24) {
		out.push((major << 5) | n);
	} else if (n < 0x100) {
		out.push((major << 5) | 24, n);
	} else if (n < 0x10000) {
		out.push((major << 5) | 25, n >> 8, n & 0xff);
	} else {
		out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
	}
}

function enc(out, v) {
	if (v === null || v === undefined) {
		out.push(0xf6);
	} else if (v === false) {
		out.push(0xf4);
	} else if (v === true) {
		out.push(0xf5);
	} else if (typeof v === 'number') {
		if (!Number.isInteger(v) || Math.abs(v) > 0xffffffff) {
			throw new Error(`cbor: unsupported number ${v}`);
		}
		if (v >= 0) {
			head(out, 0, v);
		} else {
			head(out, 1, -1 - v);
		}
	} else if (typeof v === 'string') {
		const b = new TextEncoder().encode(v);
		head(out, 3, b.length);
		out.push(...b);
	} else if (v instanceof Uint8Array) {
		head(out, 2, v.length);
		for (const x of v) {
			out.push(x);
		}
	} else if (Array.isArray(v)) {
		head(out, 4, v.length);
		v.forEach((x) => enc(out, x));
	} else {
		const keys = Object.keys(v);
		head(out, 5, keys.length);
		for (const k of keys) {
			enc(out, k);
			enc(out, v[k]);
		}
	}
}

/** @returns {Uint8Array} */
export function encode(value) {
	const out = [];
	enc(out, value);
	return Uint8Array.from(out);
}

/** @param {Uint8Array} buf */
export function decode(buf) {
	let p = 0;

	function arg(info) {
		if (info < 24) {
			return info;
		}
		const n = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
		if (n === undefined) {
			throw new Error(`cbor: invalid length encoding ${info}`);
		}
		let v = 0;
		for (let i = 0; i < n; i++) {
			v = v * 256 + buf[p++];
		}
		return v;
	}

	function item() {
		if (p >= buf.length) {
			throw new Error('cbor: truncated');
		}
		const ib = buf[p++];
		const major = ib >> 5;
		const info = ib & 0x1f;
		if (major === 7) {
			const simple = { 20: false, 21: true, 22: null, 23: undefined };
			if (!(info in simple)) {
				throw new Error(`cbor: unsupported simple value ${info}`);
			}
			return simple[info];
		}
		if (info === 31) {
			return indefinite(major);
		}
		const n = arg(info);
		switch (major) {
		case 0:
			return n;
		case 1:
			return -1 - n;
		case 2:
			p += n;
			return buf.slice(p - n, p);
		case 3:
			p += n;
			return new TextDecoder().decode(buf.subarray(p - n, p));
		case 4:
			return Array.from({ length: n }, item);
		case 5: {
			const o = {};
			for (let i = 0; i < n; i++) {
				const k = item();
				o[k] = item();
			}
			return o;
		}
		default:
			throw new Error(`cbor: unsupported major type ${major}`);
		}
	}

	/* Items up to the 0xff break code. */
	function indefinite(major) {
		const parts = [];
		while (buf[p] !== 0xff) {
			if (p >= buf.length) {
				throw new Error('cbor: truncated');
			}
			parts.push(item());
		}
		p++;
		switch (major) {
		case 2:
			return Uint8Array.from(parts.flatMap((c) => [...c]));
		case 3:
			return parts.join('');
		case 4:
			return parts;
		case 5: {
			const o = {};
			for (let i = 0; i < parts.length; i += 2) {
				o[parts[i]] = parts[i + 1];
			}
			return o;
		}
		default:
			throw new Error(`cbor: indefinite length on major type ${major}`);
		}
	}

	return item();
}
