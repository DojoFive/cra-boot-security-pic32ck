// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0
//
// MCUmgr Simple Management Protocol over a serial port that also carries the
// device's console output (Zephyr MCUMGR_TRANSPORT_UART framing).

import { encode, decode } from './cbor.js';

export const OP = { READ: 0, WRITE: 2 };
export const GROUP = { OS: 0, IMAGE: 1, FUSE: 64 };

const START = [0x06, 0x09];
const CONT = [0x04, 0x14];
const RAW_PER_LINE = 93; /* 124 base64 chars + 2 marker bytes + '\n' = 127 */

export function crc16(data) {
	let crc = 0;
	for (const b of data) {
		crc ^= b << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
		}
	}
	return crc;
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Frame one SMP packet into console lines. */
export function frame(pkt) {
	const crc = crc16(pkt);
	const len = pkt.length + 2;
	const raw = Uint8Array.from([len >> 8, len & 0xff, ...pkt, crc >> 8, crc & 0xff]);
	const out = [];
	for (let i = 0; i < raw.length; i += RAW_PER_LINE) {
		const marker = i === 0 ? START : CONT;
		const text = b64(raw.subarray(i, i + RAW_PER_LINE));
		out.push(...marker, ...new TextEncoder().encode(text), 0x0a);
	}
	return Uint8Array.from(out);
}

export function packet(op, group, id, seq, body) {
	const payload = encode(body);
	return Uint8Array.from([
		(1 << 3) | op, 0, payload.length >> 8, payload.length & 0xff,
		group >> 8, group & 0xff, seq, id, ...payload,
	]);
}

/** Splits a byte stream into console text lines and SMP packets. */
export class Deframer {
	constructor(onPacket, onLog) {
		this.onPacket = onPacket;
		this.onLog = onLog;
		this.line = [];
		this.acc = null;
	}

	push(bytes) {
		for (const b of bytes) {
			if (b !== 0x0a) {
				this.line.push(b);
				continue;
			}
			this.handleLine(Uint8Array.from(this.line));
			this.line = [];
		}
	}

	handleLine(l) {
		const isStart = l[0] === START[0] && l[1] === START[1];
		const isCont = l[0] === CONT[0] && l[1] === CONT[1];
		if (!isStart && !isCont) {
			this.onLog(new TextDecoder().decode(l).replace(/\r$/, ''));
			return;
		}
		if (isStart) {
			this.acc = [];
		} else if (this.acc === null) {
			return;
		}
		try {
			this.acc.push(...unb64(new TextDecoder().decode(l.subarray(2))));
		} catch {
			this.acc = null;
			return;
		}
		const len = (this.acc[0] << 8) | this.acc[1];
		if (this.acc.length < len + 2) {
			return;
		}
		const body = Uint8Array.from(this.acc.slice(2, len));
		const crc = (this.acc[len] << 8) | this.acc[len + 1];
		this.acc = null;
		if (crc16(body) === crc) {
			this.onPacket(body);
		}
	}
}

export class SmpError extends Error {
	constructor(message, rc = null) {
		super(message);
		this.rc = rc;
	}
}

export class Smp {
	/**
	 * @param {{readable: ReadableStream, writable: WritableStream}} port an opened port
	 * @param {(line: string) => void} onLog console lines from the device
	 */
	constructor(port, onLog = () => {}) {
		this.port = port;
		this.seq = 0;
		this.waiters = new Map();
		/* Upload retries, see upload(). Tests shorten the timeout. */
		this.chunkTimeoutMs = 1500;
		this.onRetry = () => {};
		this.deframer = new Deframer((p) => this.dispatch(p), onLog);
		this.writer = port.writable.getWriter();
		this.reader = port.readable.getReader();
		this.done = this.pump();
	}

	async pump() {
		for (;;) {
			const { value, done } = await this.reader.read();
			if (done) {
				return;
			}
			this.deframer.push(value);
		}
	}

	dispatch(pkt) {
		const seq = pkt[6];
		const w = this.waiters.get(seq);
		if (w === undefined) {
			return;
		}
		this.waiters.delete(seq);
		try {
			w.resolve(decode(pkt.subarray(8)));
		} catch (e) {
			w.reject(new SmpError(`undecodable SMP response: ${e.message}`));
		}
	}

	async request(op, group, id, body = {}, timeoutMs = 3000) {
		const seq = (this.seq = (this.seq + 1) & 0xff);
		const res = new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.waiters.delete(seq);
				reject(new SmpError(`no SMP response (group ${group}, id ${id})`));
			}, timeoutMs);
			this.waiters.set(seq, {
				resolve: (v) => { clearTimeout(t); resolve(v); },
				reject: (e) => { clearTimeout(t); reject(e); },
			});
		});
		await this.writer.write(frame(packet(op, group, id, seq, body)));
		const rsp = await res;
		const rc = rsp.rc ?? rsp.err?.rc ?? 0;
		if (rc !== 0) {
			throw new SmpError(`SMP error rc=${rc} (group ${group}, id ${id})`, rc);
		}
		return rsp;
	}

	imageList() {
		return this.request(OP.READ, GROUP.IMAGE, 0);
	}

	imageTest(hash) {
		return this.request(OP.WRITE, GROUP.IMAGE, 0, { hash, confirm: false });
	}

	reset() {
		return this.request(OP.WRITE, GROUP.OS, 5);
	}

	fuseState() {
		return this.request(OP.READ, GROUP.FUSE, 0, {}, 1500);
	}

	fuseLock() {
		return this.request(OP.WRITE, GROUP.FUSE, 0);
	}

	/** The v1.0.0 hole: clears the fuse; later firmware answers not supported. */
	factoryUnlock() {
		return this.request(OP.WRITE, GROUP.FUSE, 1);
	}

	/**
	 * Upload a signed image to the secondary slot.
	 *
	 * A chunk takes two console lines and the device has two line buffers
	 * (CONFIG_UART_MCUMGR_RX_BUF_COUNT), so now and then it drops a line and
	 * never answers. Ask again: the device replies with the offset it wants
	 * next, so a chunk that did arrive is not written twice. The first chunk
	 * gets a long timeout instead, because the device erases the slot before
	 * answering and a repeat of offset 0 would restart the upload.
	 */
	async upload(image, onProgress = () => {}, chunk = 128) {
		const attempts = 6;
		let off = 0;
		while (off < image.length) {
			const data = image.subarray(off, off + chunk);
			const body = off === 0 ? { image: 0, len: image.length, off, data } : { off, data };
			const timeoutMs = off === 0 ? 20000 : this.chunkTimeoutMs;
			let rsp;
			for (let attempt = 1; ; attempt++) {
				try {
					rsp = await this.request(OP.WRITE, GROUP.IMAGE, 1, body, timeoutMs);
					break;
				} catch (e) {
					/* Only silence is retried; an error code from the device is final. */
					if (!(e instanceof SmpError) || e.rc !== null || attempt === attempts) {
						throw e;
					}
					this.onRetry(off, attempt);
				}
			}
			off = rsp.off ?? off + data.length;
			onProgress(off / image.length);
		}
	}

	async close() {
		await this.reader.cancel().catch(() => {});
		this.reader.releaseLock();
		this.writer.releaseLock();
	}
}
