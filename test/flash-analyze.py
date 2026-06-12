# Disassembles the flash driver region of a GBA ROM and locates key
# routines, for diagnosing save incompatibilities. THUMB mode.
import sys
import struct
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB

rom_path = sys.argv[1] if len(sys.argv) > 1 else r"E:\projects\offlineGames\roms\Emerald386CN.gba"
rom = open(rom_path, "rb").read()

md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)


def find_all(needle):
    out, i = [], 0
    while (i := rom.find(needle, i)) != -1:
        out.append(i)
        i += 1
    return out


# The flash command-unlock addresses 0xE005555 / 0xE002AAA appear only in the
# real flash driver, so their refs pinpoint it without the noise of every
# 0xE000000 (SRAM/IO) reference in the ROM.
print("refs to 0x0E005555:", [hex(x) for x in find_all(struct.pack('<I', 0x0E005555))])
print("refs to 0x0E002AAA:", [hex(x) for x in find_all(struct.pack('<I', 0x0E002AAA))])
if '--all-refs' in sys.argv:
    print("refs to sSetupInfos 0x0890ED54:", [hex(x) for x in find_all(struct.pack('<I', 0x0890ED54))])
    print("refs to 0x0E000000:", [hex(x) for x in find_all(struct.pack('<I', 0x0E000000))])

# MX29L010 setup-info function pointers (from the struct at 0x90EDA0).
ptrs = struct.unpack_from('<6I', rom, 0x90EDA0)
names = ['programFlashByte', 'programFlashSector', 'eraseFlashChip', 'eraseFlashSector', 'WaitForFlashWrite', 'maxTime']
print("\nMX29L010 pointers:")
for n, p in zip(names, ptrs):
    print(f"  {n}: {hex(p)}")
print("LE26FV10N1TS pointers:")
for n, p in zip(names, struct.unpack_from('<6I', rom, 0x90EE3C)):
    print(f"  {n}: {hex(p)}")
print("DefaultFlash pointers:")
for n, p in zip(names, struct.unpack_from('<6I', rom, 0x90EDD0)):
    print(f"  {n}: {hex(p)}")


def disasm(rom_addr, size, label):
    print(f"\n===== {label} @ {hex(rom_addr | 0x08000000)} =====")
    code = rom[rom_addr:rom_addr + size]
    for ins in md.disasm(code, 0x08000000 + rom_addr):
        print(f"  {hex(ins.address)}: {ins.mnemonic:8s} {ins.op_str}")


if len(sys.argv) > 2:
    # explicit regions: addr:size pairs (hex, ROM-relative or 0x08-based)
    for spec in sys.argv[2:]:
        a, s = spec.split(':')
        addr = int(a, 16) & 0x01FFFFFF
        disasm(addr, int(s, 16), spec)
