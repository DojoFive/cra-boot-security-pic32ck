// SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
// SPDX-License-Identifier: Apache-2.0
//
// Run a CMSIS-Pack flash algorithm (.FLM, an ELF with PrgCode/PrgData
// sections and a FlashDevice descriptor) on the target through the debugger.

const PT_LOAD = 1;
const BKPT_WORD = 0xbe00be00; /* two BKPT #0, the return trap */
const MPU_CTRL = 0xe000ed94;
const REG_CFBP = 20; /* CONTROL, FAULTMASK, BASEPRI, PRIMASK */
const REG_MSPLIM_S = 28;
const FUNCS = ['Init', 'UnInit', 'EraseSector', 'ProgramPage', 'EraseChip'];

const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const cstr = (b, o) => new TextDecoder().decode(b.subarray(o, b.indexOf(0, o)));

/** Parse an FLM: load image, entry points and the FlashDevice descriptor. */
export function parseFlm(elf) {
	if (rd32(elf, 0) !== 0x464c457f || elf[4] !== 1) {
		throw new Error('not a 32-bit ELF flash algorithm');
	}
	const shoff = rd32(elf, 0x20);
	const shnum = rd16(elf, 0x30);
	const shstrndx = rd16(elf, 0x32);
	const sh = (i) => {
		const o = shoff + i * 40;
		return {
			name: rd32(elf, o), type: rd32(elf, o + 4), addr: rd32(elf, o + 12),
			off: rd32(elf, o + 16), size: rd32(elf, o + 20), link: rd32(elf, o + 24),
		};
	};
	const strtab = sh(shstrndx);
	const sections = Array.from({ length: shnum }, (_, i) => {
		const s = sh(i);
		return { ...s, name: cstr(elf, strtab.off + s.name) };
	});

	const symtab = sections.find((s) => s.type === 2);
	const symstr = sections[symtab.link];
	const syms = {};
	for (let o = symtab.off; o < symtab.off + symtab.size; o += 16) {
		syms[cstr(elf, symstr.off + rd32(elf, o))] = rd32(elf, o + 4);
	}

	const phoff = rd32(elf, 0x1c);
	const phnum = rd16(elf, 0x2c);
	let end = 0;
	const loads = [];
	for (let i = 0; i < phnum; i++) {
		const o = phoff + i * 32;
		if (rd32(elf, o) !== PT_LOAD) {
			continue;
		}
		const vaddr = rd32(elf, o + 8);
		const filesz = rd32(elf, o + 16);
		const memsz = rd32(elf, o + 20);
		loads.push({ vaddr, data: elf.subarray(rd32(elf, o + 4), rd32(elf, o + 4) + filesz), memsz });
		end = Math.max(end, vaddr + memsz);
	}
	const image = new Uint8Array((end + 3) & ~3);
	for (const l of loads) {
		image.set(l.data, l.vaddr);
	}

	const dev = sections.find((s) => s.name === 'DevDscr');
	const d = elf.subarray(dev.off, dev.off + dev.size);
	const sectors = [];
	for (let o = 160; o + 8 <= d.length; o += 8) {
		const size = rd32(d, o);
		const addr = rd32(d, o + 4);
		if (size === 0xffffffff) {
			break;
		}
		sectors.push({ size, addr });
	}
	const data = sections.find((s) => s.name === 'PrgData');

	return {
		image,
		staticBase: data ? data.addr : 0,
		entry: Object.fromEntries(FUNCS.filter((f) => f in syms).map((f) => [f, syms[f] & ~1])),
		device: {
			name: cstr(d, 2),
			start: rd32(d, 132),
			size: rd32(d, 136),
			pageSize: rd32(d, 140),
			erased: d[148],
			sectors,
		},
	};
}

/**
 * Load an algorithm into target RAM and call its entry points.
 * RAM layout from ramBase: [trap word][algorithm][page buffer][stack].
 */
export class FlashAlgo {
	constructor(dap, flm, ramBase = 0x20000000) {
		this.dap = dap;
		this.flm = flm;
		this.trap = ramBase;
		this.load = ramBase + 0x20;
		this.buf = (this.load + flm.image.length + 0xff) & ~0xff;
		this.sp = (this.buf + flm.device.pageSize + 0x1000 + 7) & ~7;
	}

	/*
	 * The core is halted wherever the firmware was, with the firmware's MPU
	 * (Zephyr marks SRAM execute-never, so the algorithm would fault on its
	 * first instruction), interrupts and stack limit still in force. Run the
	 * algorithm privileged on MSP with the MPU off and interrupts masked.
	 */
	async install() {
		await this.dap.halt();
		await this.dap.write32(MPU_CTRL, 0);
		await this.dap.writeReg(REG_CFBP, 0x00000001);
		await this.dap.writeReg(REG_MSPLIM_S, 0);
		await this.dap.write32(this.trap, BKPT_WORD);
		await this.dap.writeBytes(this.load, this.flm.image);
	}

	async call(name, ...args) {
		const fn = this.flm.entry[name];
		if (fn === undefined) {
			throw new Error(`flash algorithm has no ${name}()`);
		}
		const dap = this.dap;
		await dap.writeRegs([
			...args.map((v, i) => [i, v]),
			[9, this.load + this.flm.staticBase],
			[13, this.sp],
			[14, this.trap | 1],
			[15, this.load + fn],
			[16, 0x01000000],
		]);
		await dap.resume();
		await dap.waitHalt(20000);
		const r0 = await dap.readReg(0);
		if (r0 !== 0) {
			throw new Error(`${name}() returned ${r0}`);
		}
	}

	sectorOf(addr) {
		const { start, sectors } = this.flm.device;
		let size = sectors[0].size;
		for (const s of sectors) {
			if (addr - start >= s.addr) {
				size = s.size;
			}
		}
		return size;
	}

	/** Program [{addr, data}] that fall inside this algorithm's device range. */
	async program(segments, onProgress = () => {}) {
		const { start, size, pageSize, erased } = this.flm.device;
		const pages = new Map();
		for (const { addr, data } of segments) {
			for (let i = 0; i < data.length; i++) {
				const a = addr + i;
				if (a < start || a >= start + size) {
					continue;
				}
				const p = a - ((a - start) % pageSize);
				if (!pages.has(p)) {
					pages.set(p, new Uint8Array(pageSize).fill(erased));
				}
				pages.get(p)[a - p] = data[i];
			}
		}
		const list = [...pages.entries()].sort((x, y) => x[0] - y[0]);
		if (list.length === 0) {
			return;
		}

		const erasedSectors = new Set();
		await this.call('Init', start, 0, 1);
		for (const [i, [p]] of list.entries()) {
			const s = this.sectorOf(p);
			const base = p - ((p - start) % s);
			if (!erasedSectors.has(base)) {
				erasedSectors.add(base);
				await this.call('EraseSector', base);
			}
			onProgress('erase', (i + 1) / list.length);
		}
		await this.call('UnInit', 1);

		await this.call('Init', start, 0, 2);
		for (const [i, [p, data]] of list.entries()) {
			await this.dap.writeBytes(this.buf, data);
			await this.call('ProgramPage', p, pageSize, this.buf);
			onProgress('write', (i + 1) / list.length);
		}
		await this.call('UnInit', 2);

		for (const [i, [p, data]] of list.entries()) {
			const back = await this.dap.readBytes(p, pageSize);
			const bad = back.findIndex((b, j) => b !== data[j]);
			if (bad >= 0) {
				throw new Error(`verify failed at 0x${(p + bad).toString(16)}`);
			}
			onProgress('verify', (i + 1) / list.length);
		}
	}

	/** Erase the sectors that start at addrs and lie inside this algorithm's device. */
	async eraseSectors(addrs, onProgress = () => {}) {
		const { start, size } = this.flm.device;
		const mine = addrs.filter((a) => a >= start && a < start + size);
		if (mine.length === 0) {
			return;
		}
		await this.call('Init', start, 0, 1);
		for (const [i, a] of mine.entries()) {
			await this.call('EraseSector', a);
			onProgress('erase', (i + 1) / mine.length);
		}
		await this.call('UnInit', 1);
	}

	async eraseAll(onProgress = () => {}) {
		const { start, size } = this.flm.device;
		await this.call('Init', start, 0, 1);
		if (this.flm.entry.EraseChip !== undefined) {
			await this.call('EraseChip');
		} else {
			for (let a = start; a < start + size; a += this.sectorOf(a)) {
				await this.call('EraseSector', a);
				onProgress('erase', (a - start) / size);
			}
		}
		await this.call('UnInit', 1);
	}
}
