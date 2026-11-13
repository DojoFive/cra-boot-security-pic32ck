// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0
//
// CMSIS-DAP client: SWD line setup, DP/MEM-AP access and Cortex-M core
// control, over WebHID reports (CMSIS-DAP v1).

const CMD = {
	INFO: 0x00, CONNECT: 0x02, DISCONNECT: 0x03, TRANSFER_CONFIGURE: 0x04,
	TRANSFER: 0x05, TRANSFER_BLOCK: 0x06, SWJ_CLOCK: 0x11, SWJ_SEQUENCE: 0x12,
	SWD_CONFIGURE: 0x13,
};

const APnDP = 0x01;
const RnW = 0x02;
const DP = { DPIDR: 0x0, ABORT: 0x0, CTRL_STAT: 0x4, SELECT: 0x8 };
const AP = { CSW: 0x0, TAR: 0x4, DRW: 0xc };
/* With TAR at DHCSR, the banked data registers (AP bank 1) map BD0..BD2 to DHCSR, DCRSR, DCRDR. */
const BD = { DHCSR: 0x0, DCRSR: 0x4, DCRDR: 0x8 };
const SELECT_BD = 0x10;
const CSW_32_INC = 0x23000052;
const CSW_8_INC = 0x23000050;

const DHCSR = 0xe000edf0;
const DCRSR = 0xe000edf4;
const DCRDR = 0xe000edf8;
const DEMCR = 0xe000edfc;
const AIRCR = 0xe000ed0c;
const DBGKEY = 0xa05f0000;
const S_HALT = 1 << 17;
const S_REGRDY = 1 << 16;

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeout(p, ms, what) {
	let t;
	return Promise.race([
		p.finally(() => clearTimeout(t)),
		new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
	]);
}

/** CMSIS-DAP v1: 64-byte HID reports (Microchip nEDBG). */
export class HidTransport {
	constructor(device) {
		this.device = device;
		this.packetSize = 64;
		this.pending = null;
		this.onReport = (e) => {
			const r = this.pending;
			this.pending = null;
			r?.(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
		};
	}

	async open() {
		if (!this.device.opened) {
			await this.device.open();
		}
		this.device.addEventListener('inputreport', this.onReport);
	}

	async transfer(data) {
		const buf = new Uint8Array(this.packetSize);
		buf.set(data);
		const p = new Promise((r) => { this.pending = r; });
		await this.device.sendReport(0, buf);
		return timeout(p, 3000, 'CMSIS-DAP report');
	}

	async close() {
		this.device.removeEventListener('inputreport', this.onReport);
		await this.device.close();
	}
}

export class DapError extends Error {}

export class Dap {
	constructor(transport) {
		this.t = transport;
		this.packetSize = 64;
	}

	async cmd(bytes) {
		const r = await this.t.transfer(Uint8Array.from(bytes));
		if (r[0] !== bytes[0]) {
			throw new DapError(`CMSIS-DAP command 0x${bytes[0].toString(16)} not answered`);
		}
		return r;
	}

	async connect(clockHz = 4000000) {
		try {
			await this.t.open();
		} catch (e) {
			e.probeOpen = true;
			throw e;
		}
		this.packetSize = this.t.packetSize;
		const info = await this.cmd([CMD.INFO, 0xff]);
		if (info[1] === 2) {
			this.packetSize = Math.min(info[2] | (info[3] << 8), this.packetSize > 64 ? 1024 : 64);
		}
		const c = await this.cmd([CMD.CONNECT, 1]);
		if (c[1] !== 1) {
			throw new DapError('probe refused SWD mode');
		}
		await this.cmd([CMD.SWJ_CLOCK, ...u32(clockHz)]);
		await this.cmd([CMD.TRANSFER_CONFIGURE, 0, 0x50, 0x00, 0x00, 0x00]);
		await this.cmd([CMD.SWD_CONFIGURE, 0]);
		await this.lineReset();
		this.dpidr = await this.readDP(DP.DPIDR);
		await this.writeDP(DP.ABORT, 0x1e);
		await this.writeDP(DP.SELECT, 0);
		await this.writeDP(DP.CTRL_STAT, 0x50000000);
		for (let i = 0; ; i++) {
			if ((((await this.readDP(DP.CTRL_STAT)) & 0xa0000000) >>> 0) === 0xa0000000) {
				break;
			}
			if (i === 100) {
				throw new DapError('debug power-up not acknowledged');
			}
			await sleep(1);
		}
		await this.writeAP(AP.CSW, CSW_32_INC);
	}

	async lineReset() {
		const ones = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
		await this.cmd([CMD.SWJ_SEQUENCE, 51, ...ones]);
		await this.cmd([CMD.SWJ_SEQUENCE, 16, 0x9e, 0xe7]);
		await this.cmd([CMD.SWJ_SEQUENCE, 51, ...ones]);
		await this.cmd([CMD.SWJ_SEQUENCE, 8, 0x00]);
	}

	async disconnect() {
		await this.cmd([CMD.DISCONNECT]).catch(() => {});
		await this.t.close().catch(() => {});
	}

	/** One DAP_Transfer of [{req, data?}]; returns the read values. */
	async transfer(reqs) {
		const buf = [CMD.TRANSFER, 0, reqs.length];
		for (const r of reqs) {
			buf.push(r.req);
			if ((r.req & RnW) === 0) {
				buf.push(...u32(r.data));
			}
		}
		const rsp = await this.cmd(buf);
		if (rsp[1] !== reqs.length || rsp[2] !== 1) {
			throw new DapError(`SWD transfer failed (ack ${rsp[2]}, ${rsp[1]}/${reqs.length} done)`);
		}
		const out = [];
		let o = 3;
		for (const r of reqs) {
			if (r.req & RnW) {
				out.push(rd32(rsp, o));
				o += 4;
			}
		}
		return out;
	}

	async readDP(a) { return (await this.transfer([{ req: RnW | a }]))[0]; }
	async writeDP(a, v) { await this.transfer([{ req: a, data: v }]); }
	async writeAP(a, v) { await this.transfer([{ req: APnDP | a, data: v }]); }

	async read32(addr) {
		const [v] = await this.transfer([
			{ req: APnDP | AP.TAR, data: addr },
			{ req: APnDP | RnW | AP.DRW },
		]);
		return v;
	}

	async write32(addr, v) {
		await this.writeMany([[addr, v]]);
	}

	async write8(addr, v) {
		await this.transfer([
			{ req: APnDP | AP.CSW, data: CSW_8_INC },
			{ req: APnDP | AP.TAR, data: addr },
			{ req: APnDP | AP.DRW, data: (v & 0xff) << (8 * (addr & 3)) },
			{ req: APnDP | AP.CSW, data: CSW_32_INC },
		]);
	}

	/** Write [addr, value] pairs, batched into as few packets as fit. */
	async writeMany(pairs) {
		const per = Math.floor((this.packetSize - 3) / 10);
		for (let i = 0; i < pairs.length; i += per) {
			await this.transfer(pairs.slice(i, i + per).flatMap(([a, v]) => [
				{ req: APnDP | AP.TAR, data: a },
				{ req: APnDP | AP.DRW, data: v >>> 0 },
			]));
		}
	}

	/*
	 * Write 32-bit words. TAR auto-increments between blocks, but only within
	 * 1 KB, so it is set again at each 1 KB boundary.
	 */
	async writeWords(addr, words) {
		const max = Math.floor((this.packetSize - 5) / 4);
		for (let i = 0; i < words.length;) {
			const a = addr + i * 4;
			const n = Math.min(max, (0x400 - (a & 0x3ff)) / 4, words.length - i);
			if (i === 0 || (a & 0x3ff) === 0) {
				await this.writeAP(AP.TAR, a);
			}
			const buf = [CMD.TRANSFER_BLOCK, 0, n & 0xff, n >> 8, APnDP | AP.DRW];
			for (let j = 0; j < n; j++) {
				buf.push(...u32(words[i + j]));
			}
			const rsp = await this.cmd(buf);
			if ((rsp[1] | (rsp[2] << 8)) !== n || rsp[3] !== 1) {
				throw new DapError(`block write at 0x${a.toString(16)} failed (ack ${rsp[3]})`);
			}
			i += n;
		}
	}

	async readWords(addr, count) {
		const out = new Uint32Array(count);
		const max = Math.floor((this.packetSize - 4) / 4);
		for (let i = 0; i < count;) {
			const a = addr + i * 4;
			const n = Math.min(max, (0x400 - (a & 0x3ff)) / 4, count - i);
			if (i === 0 || (a & 0x3ff) === 0) {
				await this.writeAP(AP.TAR, a);
			}
			const rsp = await this.cmd([CMD.TRANSFER_BLOCK, 0, n & 0xff, n >> 8, APnDP | RnW | AP.DRW]);
			if ((rsp[1] | (rsp[2] << 8)) !== n || rsp[3] !== 1) {
				throw new DapError(`block read at 0x${a.toString(16)} failed (ack ${rsp[3]})`);
			}
			for (let j = 0; j < n; j++) {
				out[i + j] = rd32(rsp, 4 + j * 4);
			}
			i += n;
		}
		return out;
	}

	async writeBytes(addr, bytes) {
		if ((addr & 3) !== 0 || (bytes.length & 3) !== 0) {
			throw new DapError('writeBytes needs 4-byte alignment');
		}
		const copy = Uint8Array.from(bytes);
		await this.writeWords(addr, new Uint32Array(copy.buffer));
	}

	async readBytes(addr, len) {
		return new Uint8Array((await this.readWords(addr, len / 4)).buffer);
	}

	async waitHalt(ms = 1000) {
		const end = Date.now() + ms;
		while (((await this.read32(DHCSR)) & S_HALT) === 0) {
			if (Date.now() > end) {
				throw new DapError('core did not halt');
			}
			await sleep(1);
		}
	}

	async halt() {
		await this.write32(DHCSR, DBGKEY | 0x3);
		await this.waitHalt();
	}

	async resume() {
		await this.write32(DHCSR, DBGKEY | 0x1);
	}

	/** Reset and stop at the reset vector, before any firmware runs. */
	async resetHalt() {
		await this.write32(DHCSR, DBGKEY | 0x3);
		await this.write32(DEMCR, 1);
		await this.write32(AIRCR, 0x05fa0004).catch(() => {});
		await sleep(100);
		await this.waitHalt();
		await this.write32(DEMCR, 0);
	}

	/** Reset into the new firmware with the debugger detached from the core. */
	async resetRun() {
		await this.write32(DEMCR, 0);
		await this.write32(DHCSR, DBGKEY);
		await this.write32(AIRCR, 0x05fa0004).catch(() => {});
	}

	/*
	 * One DAP_Transfer on the core debug registers through the banked data
	 * registers, so each access needs no TAR write. SELECT is back on bank 0
	 * at the end of the packet; after a failure a reconnect resets it.
	 */
	async banked(reqs) {
		return this.transfer([
			{ req: APnDP | AP.TAR, data: DHCSR },
			{ req: DP.SELECT, data: SELECT_BD },
			...reqs,
			{ req: DP.SELECT, data: 0 },
		]);
	}

	/*
	 * Write core registers [[n, v]], several per packet. Each DCRSR write is
	 * followed by a DHCSR read; the transfer completes in a few core cycles,
	 * well before the next SWD access, so S_REGRDY is checked, not polled.
	 */
	async writeRegs(pairs) {
		const per = Math.floor((this.packetSize - 18) / 11);
		for (let i = 0; i < pairs.length; i += per) {
			const dhcsr = await this.banked(pairs.slice(i, i + per).flatMap(([n, v]) => [
				{ req: APnDP | BD.DCRDR, data: v >>> 0 },
				{ req: APnDP | BD.DCRSR, data: n | 0x10000 },
				{ req: APnDP | RnW | BD.DHCSR },
			]));
			if (dhcsr.some((d) => (d & S_REGRDY) === 0)) {
				throw new DapError('core register write not acknowledged');
			}
		}
	}

	async writeReg(n, v) {
		await this.writeRegs([[n, v]]);
	}

	async readReg(n) {
		const [dhcsr, v] = await this.banked([
			{ req: APnDP | BD.DCRSR, data: n },
			{ req: APnDP | RnW | BD.DHCSR },
			{ req: APnDP | RnW | BD.DCRDR },
		]);
		if ((dhcsr & S_REGRDY) === 0) {
			throw new DapError('core register read not acknowledged');
		}
		return v;
	}
}
