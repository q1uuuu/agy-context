#!/usr/bin/env python3
"""Unlock all 3 context-window gates in the agy CLI (plus optional env-var restore).

Verified end-to-end on macOS arm64, agy 1.4.12.
Container + Go pclntab locating supports Mach-O, ELF, and PE (arm64 & x86-64).

Gate 1 -- model.SelectorModel.offersContextWindow
    Exposes /model -> Context: [Default] [256K] [512K] [900K] (Tab key) for all
    models instead of gating on "Gemini 4 Argon" + internal experiment state.
        arm64 : mov w0, #1 ; ret           -> 20 00 80 52 c0 03 5f d6
        x86-64: mov eax, 1 ; ret           -> b8 01 00 00 00 c3

Gate 2 -- store.(*Store).ContextWindow -> store.(*Store).ContextWindowChoice
    Bypasses the "Gemini 4 Argon" whitelist and release-folded experiment gate
    so Store.ContextWindow() returns the user's persisted ContextWindowChoice
    ("256K", "512K", "900K", or "" for Default) to Manager.syncContextWindow().
    On arm64, preserves store.AutoCompactOverride priority before tail-calling
    Store.ContextWindowChoice with a clean deallocated frame (Go PCDATA safe);
    falls back to a direct entry tail-jump on x86-64 or altered layouts.

Gate 3A -- utils.GetCheckpointConfig
    Removes the hardcoded min(threshold, 256000) (0x3e800) ceiling inside
    cortex/utils/utils.GetCheckpointConfig so defaultCp.MaxTokenLimit holds the
    model's full physical budget: contextWindow - max(maxOutputTokens, 40000)
    (983,040 tokens on 1M-context / 64K-output models).
        arm64 : 24-byte 0x3e800 cmp/csel   -> 6 x nop (1f 20 03 d5)
        x86-64: 14-byte 0x3e800 cmp/cmovb  -> mov %edx, %esi + 12 x nop

Gate 3B -- config.applyFeatureProviderCheckpointOverrideConfig
    Clears expCp.MaxTokenLimit (offset +0xc) before MergeConfigsDedup merges
    CASCADE_USE_EXPERIMENT_CHECKPOINTER (which hardcodes "max_token_limit":
    "256000" in model_profiles), preserving defaultCp.MaxTokenLimit (983,040)
    while retaining all modern checkpointer strategy and summary settings.

Bonus  -- store.AutoCompactOverride (arm64, optional; skip with --no-env-fix)
    Restores os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE") in place of the
    constant-folded strings.TrimSpace("") call so percentage ("80%") or integer
    token overrides ("650000") work via environment variable.

Usage:
    python3 agy-patch.py --binary ~/.local/bin/agy --in-place
    python3 agy-patch.py --binary ~/.local/bin/agy --locate
    python3 agy-patch.py --binary ~/.local/bin/agy --dry-run
"""

import argparse
import hashlib
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile

PCLNTAB_MAGIC = 0xFFFFFFF1
ENV_NAME = b"AGY_CLI_AUTO_COMPACT_OVERRIDE"

FUNC_OFFERS = "model.SelectorModel.offersContextWindow"
FUNC_STORE_CW = "store.(*Store).ContextWindow"
FUNC_STORE_CHOICE = "store.(*Store).ContextWindowChoice"
FUNC_CHECKPOINT = "utils.GetCheckpointConfig"
FUNC_EXP_CHECKPOINT = "config.applyFeatureProviderCheckpointOverrideConfig"
FUNC_SELECT_EXP_KEY = "config.selectCheckpointExperimentKey"
FUNC_OVERRIDE = "store.AutoCompactOverride"

NOP_ARM64 = struct.pack("<I", 0xD503201F)
RET_TRUE_ARM64 = struct.pack("<II", 0x52800020, 0xD65F03C0)      # mov w0,#1 ; ret
RET_TRUE_X64 = bytes.fromhex("b801000000c3")                     # mov eax,1 ; ret

# arm64 folded Getenv setup: nop ; mov x0,xzr ; mov x1,xzr
GETENV_STUB_ARM64 = struct.pack("<III", 0xD503201F, 0xAA1F03E0, 0xAA1F03E1)

# Gate 3 exact 0x3e800 (256,000) clamp sequences inside utils.GetCheckpointConfig
CLAMP_256K_ARM64 = bytes.fromhex(
    "04009dd2"  # mov  x4, #0xe800
    "6400a0f2"  # movk x4, #0x3, lsl #16   (0x3e800 = 256000)
    "7f00046b"  # cmp  w3, w4
    "04009dd2"  # mov  x4, #0xe800
    "6400a0f2"  # movk x4, #0x3, lsl #16
    "6330849a"  # csel x3, x3, x4, lo
)
CLAMP_256K_X64 = bytes.fromhex(
    "81fa00e80300"  # cmp  $0x3e800, %edx
    "be00e80300"    # mov  $0x3e800, %esi
    "0f42f2"        # cmovb %edx, %esi
)
PATCH_256K_X64 = bytes.fromhex("89d6") + b"\x90" * 12  # mov %edx, %esi + 12x nop


class PatchError(Exception):
    pass


# --------------------------------------------------------------------------
# Binary container: locate machine-code section (.text / __text)
# --------------------------------------------------------------------------

def find_text_section(data):
    """Return (text_vmaddr, text_fileoff, arch)."""
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return _macho_text(data)
    if data[:4] == b"\x7fELF":
        return _elf_text(data)
    if data[:2] == b"MZ":
        return _pe_text(data)
    raise PatchError("unrecognised binary container (expected Mach-O, ELF, or PE)")


def _macho_text(data):
    ncmds = struct.unpack_from("<I", data, 16)[0]
    cputype = struct.unpack_from("<I", data, 4)[0]
    arch = {0x0100000C: "arm64", 0x01000007: "x86-64"}.get(cputype)
    if arch is None:
        raise PatchError(f"unsupported Mach-O cputype {cputype:#x}")
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            sect = off + 72
            for _ in range(nsects):
                if data[sect:sect + 16].rstrip(b"\0") == b"__text":
                    addr, _sz, offset = struct.unpack_from("<QQI", data, sect + 32)
                    return addr, offset, arch
                sect += 80
        off += size
    raise PatchError("__text section not found in Mach-O")


def _elf_text(data):
    if data[4] != 2 or data[5] != 1:
        raise PatchError("only 64-bit little-endian ELF is supported")
    machine = struct.unpack_from("<H", data, 18)[0]
    arch = {0xB7: "arm64", 0x3E: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported ELF machine {machine:#x}")
    shoff = struct.unpack_from("<Q", data, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 58)
    strtab_off = struct.unpack_from("<Q", data, shoff + shstrndx * shentsize + 24)[0]
    for i in range(shnum):
        sh = shoff + i * shentsize
        nameoff = struct.unpack_from("<I", data, sh)[0]
        end = data.find(b"\0", strtab_off + nameoff)
        if data[strtab_off + nameoff:end] == b".text":
            addr, offset = struct.unpack_from("<QQ", data, sh + 16)
            return addr, offset, arch
    raise PatchError(".text section not found in ELF")


def _pe_text(data):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise PatchError("invalid PE header signature")
    machine = struct.unpack_from("<H", data, pe + 4)[0]
    arch = {0xAA64: "arm64", 0x8664: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported PE machine {machine:#x}")
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    image_base = struct.unpack_from("<Q", data, opt + 24)[0]
    sect = opt + opt_size
    for _ in range(nsec):
        if data[sect:sect + 8].rstrip(b"\0") == b".text":
            _vsize, vaddr, _rawsize, rawptr = struct.unpack_from("<IIII", data, sect + 8)
            return image_base + vaddr, rawptr, arch
        sect += 40
    raise PatchError(".text section not found in PE")


# --------------------------------------------------------------------------
# Go .gopclntab symbol resolution
# --------------------------------------------------------------------------

def find_pclntab(data):
    magic = struct.pack("<I", PCLNTAB_MAGIC) + b"\x00\x00"
    pos = 0
    while True:
        i = data.find(magic, pos)
        if i < 0:
            raise PatchError("Go pclntab not found")
        pos = i + 1
        # minLC is 1 on x86-64, 2 on s390x, 4 on arm64; ptrSize is 8 on 64-bit
        if data[i + 6] not in (1, 2, 4) or data[i + 7] != 8:
            continue
        nfunc = struct.unpack_from("<Q", data, i + 8)[0]
        if not 1000 < nfunc < 5_000_000:
            continue
        fn_off = struct.unpack_from("<Q", data, i + 32)[0]
        if i + fn_off + 16 > len(data):
            continue
        head = data[i + fn_off:i + fn_off + 16]
        if not head or not all(0x20 <= c < 0x7F or c == 0 for c in head):
            continue
        return i, nfunc


def build_functions(data):
    """Map trailing Go func name -> (entryoff, size)."""
    base, nfunc = find_pclntab(data)
    fnstart = base + struct.unpack_from("<Q", data, base + 32)[0]
    pcln = base + struct.unpack_from("<Q", data, base + 64)[0]

    funcs = {}
    for i in range(nfunc):
        off = pcln + i * 8
        if off + 16 > len(data):
            break
        entryoff, funcoff = struct.unpack_from("<II", data, off)
        next_entryoff = struct.unpack_from("<I", data, off + 8)[0]
        rec = pcln + funcoff
        if rec + 8 > len(data):
            continue
        nameoff = struct.unpack_from("<i", data, rec + 4)[0]
        start = fnstart + nameoff
        end = data.find(b"\x00", start, start + 1024)
        if end < 0:
            continue
        try:
            name = data[start:end].decode("ascii")
        except UnicodeDecodeError:
            continue
        size = max(0, next_entryoff - entryoff)
        funcs.setdefault(name.rsplit("/", 1)[-1], (entryoff, size))
    if not funcs:
        raise PatchError("functab produced no symbols")
    return funcs


# --------------------------------------------------------------------------
# Instruction encoders / helpers
# --------------------------------------------------------------------------

def encode_adrp(rd, pc, target):
    delta = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12
    if not -(1 << 20) <= delta < (1 << 20):
        raise PatchError("adrp target out of range")
    imm21 = delta & 0x1FFFFF
    return 0x90000000 | ((imm21 & 3) << 29) | ((imm21 >> 2) << 5) | rd


def encode_add_imm(rd, rn, imm12):
    if not 0 <= imm12 <= 0xFFF:
        raise PatchError("add immediate out of range")
    return 0x91000000 | (imm12 << 10) | (rn << 5) | rd


def encode_movz64(rd, imm16):
    return 0xD2800000 | (imm16 << 5) | rd


def encode_b(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("b target out of range")
    return 0x14000000 | ((delta >> 2) & 0x3FFFFFF)


def encode_bl(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("bl target out of range")
    return 0x94000000 | ((delta >> 2) & 0x3FFFFFF)


def decode_bl_target(pc, word):
    if (word & 0xFC000000) != 0x94000000:
        return None
    imm26 = word & 0x3FFFFFF
    if imm26 & 0x2000000:
        imm26 -= 0x4000000
    return pc + imm26 * 4


# --------------------------------------------------------------------------
# Gate 1: model.SelectorModel.offersContextWindow -> return true
# --------------------------------------------------------------------------

def patch_gate1_ui(data, funcs, text_va, text_off, arch):
    if FUNC_OFFERS not in funcs:
        return False, f"[Gate 1] {FUNC_OFFERS}: not present in binary (skipped)"
    entryoff, _ = funcs[FUNC_OFFERS]
    blob = RET_TRUE_ARM64 if arch == "arm64" else RET_TRUE_X64
    off = text_off + entryoff
    if bytes(data[off:off + len(blob)]) == blob:
        return False, f"[Gate 1] {FUNC_OFFERS}: already patched"
    data[off:off + len(blob)] = blob
    return True, (f"[Gate 1] {FUNC_OFFERS}: entry {text_va + entryoff:#x} -> "
                  f"return true ({blob.hex(' ')})")


# --------------------------------------------------------------------------
# Gate 2: store.(*Store).ContextWindow -> store.(*Store).ContextWindowChoice
# --------------------------------------------------------------------------

def _try_arm64_rich_gate2(data, funcs, text_va, text_off):
    """Preserve AutoCompactOverride priority, then tail-call ContextWindowChoice.

    Returns (handled: bool, changed: bool, message: str).
    """
    if FUNC_OVERRIDE not in funcs:
        return False, False, ""

    cw_entry, cw_size = funcs[FUNC_STORE_CW]
    ch_entry, _ = funcs[FUNC_STORE_CHOICE]
    ov_entry, _ = funcs[FUNC_OVERRIDE]

    fn_off = text_off + cw_entry
    fn_va = text_va + cw_entry
    ch_va = text_va + ch_entry
    ov_va = text_va + ov_entry

    if cw_size < 0x100:
        return False, False, ""

    # 1. Locate `str x0, [sp, #imm]` in prologue (saves receiver s *Store)
    ldr_x0_sp = None
    for rel in range(0, min(0x40, cw_size), 4):
        w = struct.unpack_from("<I", data, fn_off + rel)[0]
        if (w & 0xFFC003FF) == 0xF90003E0:
            ldr_x0_sp = 0xF94003E0 | (w & 0x003FFC00)
            break
    if ldr_x0_sp is None:
        return False, False, ""

    # 2. Locate `mov x0, #-1` followed by `tbnz x0, #0x3f, ...` (or already nop)
    argon_br_rel = None
    for rel in range(0x40, cw_size - 8, 4):
        w0, w1 = struct.unpack_from("<II", data, fn_off + rel)
        if w0 == 0x92800000 and ((w1 & 0xFFF8001F) == 0xB7F80000 or w1 == 0xD503201F):
            argon_br_rel = rel + 4
            break
    if argon_br_rel is None:
        return False, False, ""

    # 3. Locate `bl store.AutoCompactOverride` + `cbnz x1, epilogue`
    bl_ov_rel = None
    for rel in range(argon_br_rel + 4, cw_size - 24, 4):
        w = struct.unpack_from("<I", data, fn_off + rel)[0]
        if decode_bl_target(fn_va + rel, w) == ov_va:
            bl_ov_rel = rel
            break
    if bl_ov_rel is None:
        return False, False, ""

    w_cbnz = struct.unpack_from("<I", data, fn_off + bl_ov_rel + 4)[0]
    if (w_cbnz & 0xFF00001F) != 0xB5000001:
        return False, False, ""
    imm19 = (w_cbnz >> 5) & 0x7FFFF
    if imm19 & 0x40000:
        imm19 -= 0x80000
    epi_rel = bl_ov_rel + 4 + imm19 * 4
    if not (0 < epi_rel <= cw_size - 12):
        return False, False, ""

    epi_w0, epi_w1, epi_w2 = struct.unpack_from("<III", data, fn_off + epi_rel)
    if epi_w2 != 0xD65F03C0:  # ret
        return False, False, ""

    # Skip optional compiler nop right after cbnz
    tail_rel = bl_ov_rel + 8
    if struct.unpack_from("<I", data, fn_off + tail_rel)[0] == 0xD503201F:
        tail_rel += 4
    if tail_rel + 16 > epi_rel:
        return False, False, ""

    b_choice = encode_b(fn_va + tail_rel + 12, ch_va)
    tail_blob = struct.pack("<IIII", ldr_x0_sp, epi_w0, epi_w1, b_choice)

    argon_site = fn_off + argon_br_rel
    tail_site = fn_off + tail_rel

    already_nop = bytes(data[argon_site:argon_site + 4]) == NOP_ARM64
    already_tail = bytes(data[tail_site:tail_site + 16]) == tail_blob
    if already_nop and already_tail:
        return True, False, f"[Gate 2] {FUNC_STORE_CW}: already patched"

    data[argon_site:argon_site + 4] = NOP_ARM64
    data[tail_site:tail_site + 16] = tail_blob
    return True, True, (
        f"[Gate 2] {FUNC_STORE_CW}: whitelist bypassed @ {fn_va + argon_br_rel:#x} "
        f"+ tail-call {FUNC_STORE_CHOICE} @ {fn_va + tail_rel:#x}"
    )


def patch_gate2_store(data, funcs, text_va, text_off, arch):
    for sym in (FUNC_STORE_CW, FUNC_STORE_CHOICE):
        if sym not in funcs:
            raise PatchError(f"symbol not found: {sym}")

    cw_entry, _ = funcs[FUNC_STORE_CW]
    ch_entry, _ = funcs[FUNC_STORE_CHOICE]
    fn_off = text_off + cw_entry
    fn_va = text_va + cw_entry
    ch_va = text_va + ch_entry

    if arch == "arm64":
        entry_jmp = struct.pack("<I", encode_b(fn_va, ch_va))
        if bytes(data[fn_off:fn_off + 4]) == entry_jmp:
            return False, f"[Gate 2] {FUNC_STORE_CW}: already patched (entry jump)"
        handled, changed, msg = _try_arm64_rich_gate2(data, funcs, text_va, text_off)
        if handled:
            return changed, msg
        data[fn_off:fn_off + 4] = entry_jmp
        return True, (f"[Gate 2] {FUNC_STORE_CW}: entry {fn_va:#x} -> "
                      f"b {FUNC_STORE_CHOICE} ({entry_jmp.hex(' ')})")

    # x86-64: 5-byte jmp rel32 at entry -> ContextWindowChoice (%rax receiver intact)
    rel32 = ch_va - (fn_va + 5)
    if not -(1 << 31) <= rel32 < (1 << 31):
        raise PatchError("jmp rel32 out of range for Store.ContextWindow")
    entry_jmp = b"\xe9" + struct.pack("<i", rel32)
    if bytes(data[fn_off:fn_off + 5]) == entry_jmp:
        return False, f"[Gate 2] {FUNC_STORE_CW}: already patched"
    data[fn_off:fn_off + 5] = entry_jmp
    return True, (f"[Gate 2] {FUNC_STORE_CW}: entry {fn_va:#x} -> "
                  f"jmp {FUNC_STORE_CHOICE} ({entry_jmp.hex(' ')})")


# --------------------------------------------------------------------------
# Gate 3A: utils.GetCheckpointConfig -> remove 256,000 (0x3e800) ceiling
# --------------------------------------------------------------------------

def _find_generic_arm64_clamp(body):
    """Matcher for movz xR, #low ; movk xR, #high, lsl #16 ... csel xD, xD, xR, lo.
    Supports any token clamp >= 100,000 (e.g. 256K, 512K, 900K, 1M)."""
    hits = []
    for rel in range(0, len(body) - 24, 4):
        w0, w1 = struct.unpack_from("<II", body, rel)
        # movz xR, #imm, lsl #0 (0xD2800000)
        # movk xR, #imm, lsl #16 (0xF2A00000)
        if (w0 & 0xFFE00000) != 0xD2800000 or (w1 & 0xFFE00000) != 0xF2A00000:
            continue
        reg_lim = w0 & 0x1F
        if (w1 & 0x1F) != reg_lim:
            continue
        curr_lim = ((w0 >> 5) & 0xFFFF) | (((w1 >> 5) & 0xFFFF) << 16)
        if curr_lim < 100000:
            continue
        # Look ahead up to 5 instructions for `csel xD, xD, xR, lo`
        for end_rel in range(rel + 12, min(rel + 32, len(body)), 4):
            wc = struct.unpack_from("<I", body, end_rel)[0]
            if (wc & 0xFFE0FC00) == 0x9A803000:  # csel xD, xN, xM, lo (cond=0011)
                rd = wc & 0x1F
                rn = (wc >> 5) & 0x1F
                rm = (wc >> 16) & 0x1F
                if rd == rn and rm == reg_lim:
                    hits.append((rel, end_rel + 4 - rel, curr_lim, reg_lim, rd))
                    break
    return hits

# Backward-compatible alias
_find_generic_arm64_256k_clamp = lambda body: [(h[0], h[1]) for h in _find_generic_arm64_clamp(body)]


def patch_gate3a_checkpoint(data, funcs, text_va, text_off, arch, target_limit=None):
    if FUNC_CHECKPOINT not in funcs:
        raise PatchError(f"symbol not found: {FUNC_CHECKPOINT}")
    entryoff, size = funcs[FUNC_CHECKPOINT]
    if size == 0:
        size = 0x600
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    target = int(target_limit) if target_limit is not None else 0

    if arch == "arm64":
        nop6 = NOP_ARM64 * 6
        if target > 0:
            low16 = target & 0xffff
            high16 = (target >> 16) & 0xffff
            mov_low = 0xd2800000 | (low16 << 5) | 4
            movk_high = 0xf2a00000 | (high16 << 5) | (1 << 21) | 4
            cmp_w3_x4 = 0x6b04007f
            csel = 0x9a843063
            target_clamp = struct.pack("<IIIIII", mov_low, movk_high, cmp_w3_x4, mov_low, movk_high, csel)

            idx = body.find(target_clamp)
            if idx >= 0:
                return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already clamped to {target:,} tokens (0x{target:x})"

            generic = _find_generic_arm64_256k_clamp(body)
            if generic:
                rel = generic[0][0]
                site = fn_off + rel
                data[site:site + 24] = target_clamp
                return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: clamped to {target:,} tokens (0x{target:x}) "
                              f"@ {fn_va + rel:#x}")

            nop_idx = body.find(nop6)
            if nop_idx >= 0:
                site = fn_off + nop_idx
                data[site:site + 24] = target_clamp
                return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: clamped to {target:,} tokens (0x{target:x}) "
                              f"@ {fn_va + nop_idx:#x}")

            raise PatchError(f"{FUNC_CHECKPOINT}: arm64 clamp site not found")
        else:
            if body.find(nop6) >= 0:
                return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already patched (unlimited)"

            idx = body.find(CLAMP_256K_ARM64)
            if idx >= 0:
                site = fn_off + idx
                data[site:site + 24] = nop6
                return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed 256K clamp @ {fn_va + idx:#x} (6x nop)")

            generic = _find_generic_arm64_256k_clamp(body)
            if generic:
                rel, length = generic[0]
                site = fn_off + rel
                data[site:site + length] = NOP_ARM64 * (length // 4)
                return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed clamp @ {fn_va + rel:#x} ({length // 4}x nop)")

            raise PatchError(f"{FUNC_CHECKPOINT}: arm64 clamp pattern not found")

    # x86-64
    clamp_re = rb'\x81([\xf8-\xff])(....)[\xb8-\xbf](....)\x0f\x42([\xc0-\xff])'
    bypassed_re = rb'\x89([\xc0-\xff])\x90{12}'

    valid_clamps = []
    for m in re.finditer(clamp_re, body):
        c_lim = struct.unpack("<I", m.group(2))[0]
        if c_lim >= 100000:
            valid_clamps.append((m, c_lim))

    m_clamp = valid_clamps[0][0] if valid_clamps else None
    m_bypassed = re.search(bypassed_re, body)

    if target > 0:
        lim_bytes = struct.pack("<I", target)
        if m_clamp:
            reg1 = m_clamp.group(1)[0] - 0xf8
            curr_lim = struct.unpack("<I", m_clamp.group(2))[0]
            cmov_byte = m_clamp.group(4)[0]
            reg2 = (cmov_byte - 0xc0 - reg1) // 8

            if curr_lim == target:
                return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already clamped to {target:,} tokens (0x{target:x})"

            cmp_b = bytes([0x81, 0xf8 + reg1]) + lim_bytes
            mov_b = bytes([0xb8 + reg2]) + lim_bytes
            cmov_b = bytes([0x0f, 0x42, 0xc0 + reg2 * 8 + reg1])
            new_clamp = cmp_b + mov_b + cmov_b

            site = fn_off + m_clamp.start()
            data[site:site + 14] = new_clamp
            return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: updated clamp from {curr_lim:,} to {target:,} tokens (0x{target:x}) "
                          f"@ {fn_va + m_clamp.start():#x}")

        if m_bypassed:
            modrm = m_bypassed.group(1)[0]
            reg1 = (modrm - 0xc0) >> 3
            reg2 = (modrm - 0xc0) & 7

            cmp_b = bytes([0x81, 0xf8 + reg1]) + lim_bytes
            mov_b = bytes([0xb8 + reg2]) + lim_bytes
            cmov_b = bytes([0x0f, 0x42, 0xc0 + reg2 * 8 + reg1])
            new_clamp = cmp_b + mov_b + cmov_b

            site = fn_off + m_bypassed.start()
            data[site:site + 14] = new_clamp
            return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: hard-clamped to {target:,} tokens (0x{target:x}) "
                          f"@ {fn_va + m_bypassed.start():#x}")

        raise PatchError(f"{FUNC_CHECKPOINT}: x86-64 clamp site not found")
    else:
        if m_bypassed:
            return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already patched (unlimited)"

        if m_clamp:
            reg1 = m_clamp.group(1)[0] - 0xf8
            curr_lim = struct.unpack("<I", m_clamp.group(2))[0]
            cmov_byte = m_clamp.group(4)[0]
            reg2 = (cmov_byte - 0xc0 - reg1) // 8

            mov_modrm = 0xc0 + reg1 * 8 + reg2
            patch_bytes = bytes([0x89, mov_modrm]) + b'\x90' * 12

            site = fn_off + m_clamp.start()
            data[site:site + 14] = patch_bytes
            return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed {curr_lim:,} clamp @ {fn_va + m_clamp.start():#x} "
                          f"(mov reg,reg + 12x nop)")

        raise PatchError(f"{FUNC_CHECKPOINT}: x86-64 clamp site not found")


# --------------------------------------------------------------------------
# Gate 3B: config.applyFeatureProviderCheckpointOverrideConfig
#          prevent CASCADE_USE_EXPERIMENT_CHECKPOINTER from resetting 256K
# --------------------------------------------------------------------------

def patch_gate3b_exp_checkpoint(data, funcs, text_va, text_off, arch):
    if FUNC_EXP_CHECKPOINT not in funcs:
        raise PatchError(f"symbol not found: {FUNC_EXP_CHECKPOINT}")
    entryoff, size = funcs[FUNC_EXP_CHECKPOINT]
    if size == 0:
        size = 0x200
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    if arch == "arm64":
        # Primary: clear expCp.MaxTokenLimit ([x0, #0xc] = 0) before MergeConfigsDedup
        for rel in range(4, len(body) - 16, 4):
            w_prev, w0, w1 = struct.unpack_from("<III", body, rel - 4)
            if (w_prev & 0xFC000000) != 0x94000000:
                continue
            if (w0 & 0xFF00001F) == 0xB4000000 and w1 == 0xB9000C1F:
                return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
            if (w0 & 0xFF00001F) != 0xB4000001:  # cbz x1, <merge_prep>
                continue
            imm19 = (w0 >> 5) & 0x7FFFF
            if imm19 & 0x40000:
                imm19 -= 0x80000
            span = imm19 * 4
            if not (8 <= span <= 64 and rel + span + 8 <= len(body)):
                continue
            wm0, wm1 = struct.unpack_from("<II", body, rel + span)
            if (wm0 & 0xFFC003FF) == 0xF94003E1 and wm1 == 0xAA0003E2:
                cbz_x0 = w0 & 0xFFFFFFE0          # cbz x0, <merge_prep>
                str_wzr = 0xB9000C1F              # str wzr, [x0, #0xc]
                blob = (
                    struct.pack("<II", cbz_x0, str_wzr)
                    + NOP_ARM64 * ((span - 8) // 4)
                )
                data[fn_off + rel:fn_off + rel + span] = blob
                return True, (
                    f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: zeroed expCp.MaxTokenLimit "
                    f"@ {fn_va + rel:#x} (cbz x0 + str wzr,[x0,#0xc])"
                )

        # Fallback: bypass HasFlag(expKey) branch after selectCheckpointExperimentKey
        if FUNC_SELECT_EXP_KEY in funcs:
            sel_va = text_va + funcs[FUNC_SELECT_EXP_KEY][0]
            for rel in range(0, len(body) - 16, 4):
                w = struct.unpack_from("<I", body, rel)[0]
                if decode_bl_target(fn_va + rel, w) != sel_va:
                    continue
                for scan in range(rel + 4, min(rel + 72, len(body) - 4), 4):
                    wb, wn = struct.unpack_from("<II", body, scan)
                    if (wb & 0xFFFFFC1F) != 0xD63F0000:  # blr xR
                        continue
                    if wn == 0xD503201F:
                        return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
                    if (wn & 0xFFFE001F) == 0x37000000 or (wn & 0x7F00001F) == 0x35000000:
                        data[fn_off + scan + 4:fn_off + scan + 8] = NOP_ARM64
                        return True, (
                            f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                            f"override @ {fn_va + scan + 4:#x}"
                        )
        raise PatchError(f"{FUNC_EXP_CHECKPOINT}: arm64 override site not found")

    # x86-64: bypass HasFlag(expKey) `test %al,%al ; jne ...` after selectCheckpointExperimentKey
    if FUNC_SELECT_EXP_KEY not in funcs:
        raise PatchError(f"symbol not found: {FUNC_SELECT_EXP_KEY}")
    sel_va = text_va + funcs[FUNC_SELECT_EXP_KEY][0]
    for rel in range(0, len(body) - 12):
        if body[rel] != 0xE8:
            continue
        disp = struct.unpack_from("<i", body, rel + 1)[0]
        if fn_va + rel + 5 + disp != sel_va:
            continue
        window = body[rel + 5:min(len(body), rel + 105)]
        t_idx = window.find(b"\x84\xc0")  # test %al, %al
        if t_idx < 0:
            continue
        j_off = rel + 5 + t_idx + 2
        if body[j_off:j_off + 2] == b"\x90\x90":
            return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
        if body[j_off] == 0x75:  # jne rel8
            data[fn_off + j_off:fn_off + j_off + 2] = b"\x90\x90"
            return True, (f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                          f"override @ {fn_va + j_off:#x} (2x nop)")
        if body[j_off:j_off + 2] == b"\x0f\x85":  # jne rel32
            data[fn_off + j_off:fn_off + j_off + 6] = b"\x90" * 6
            return True, (f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                          f"override @ {fn_va + j_off:#x} (6x nop)")
    raise PatchError(f"{FUNC_EXP_CHECKPOINT}: x86-64 override site not found")


# --------------------------------------------------------------------------
# Bonus Patch 4 (arm64 optional): restore AGY_CLI_AUTO_COMPACT_OVERRIDE
# --------------------------------------------------------------------------

def patch_env(data, funcs, text_va, text_off, arch):
    if arch != "arm64":
        raise PatchError("env-var restore is arm64-only")
    for needed in (FUNC_OVERRIDE, "strings.TrimSpace", "os.Getenv"):
        if needed not in funcs:
            raise PatchError(f"symbol not found: {needed}")

    entryoff, size = funcs[FUNC_OVERRIDE]
    start = text_off + entryoff
    body = bytes(data[start:start + (size or 512)])

    name_off = data.find(ENV_NAME)
    if name_off < 0:
        raise PatchError("env var string missing from rodata")
    target = text_va - text_off + name_off
    site_va = text_va + entryoff

    hits = [m.start() for m in re.finditer(re.escape(GETENV_STUB_ARM64), body)]
    if len(hits) != 1:
        # Check if `bl os.Getenv` is already wired inside store.AutoCompactOverride
        getenv_va = text_va + funcs["os.Getenv"][0]
        for rel in range(0, len(body) - 4, 4):
            w = struct.unpack_from("<I", body, rel)[0]
            if decode_bl_target(site_va + rel, w) == getenv_va:
                return False, f"[EnvFix] {FUNC_OVERRIDE}: already patched"
        raise PatchError(f"{FUNC_OVERRIDE}: expected 1 folded Getenv stub, found {len(hits)}")

    site = start + hits[0]
    bl_site = site + 12
    old_bl = struct.unpack_from("<I", data, bl_site)[0]
    bl_pc = site_va + hits[0] + 12
    trim_va = text_va + funcs["strings.TrimSpace"][0]
    if decode_bl_target(bl_pc, old_bl) != trim_va:
        raise PatchError("stub bl does not target strings.TrimSpace")

    words = (
        encode_adrp(0, site_va + hits[0], target),
        encode_add_imm(0, 0, target & 0xFFF),
        encode_movz64(1, len(ENV_NAME)),
        encode_bl(bl_pc, text_va + funcs["os.Getenv"][0]),
    )
    data[site:site + 16] = b"".join(struct.pack("<I", w) for w in words)
    return True, (f"[EnvFix] {FUNC_OVERRIDE}: restored {ENV_NAME.decode()} "
                  f"(strings.TrimSpace -> os.Getenv @ {bl_pc:#x})")


# --------------------------------------------------------------------------
# Signing & atomic write
# --------------------------------------------------------------------------

def _extract_adhoc_safe_entitlements(src_path):
    """Read existing Mach-O entitlements (e.g. allow-jit) safe for ad-hoc signing."""
    if sys.platform != "darwin" or not os.path.exists(src_path):
        return None
    res = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", src_path],
        capture_output=True,
    )
    if res.returncode != 0 or not res.stdout.strip().startswith(b"<?xml"):
        return None
    try:
        ent = plistlib.loads(res.stdout)
    except Exception:
        return None
    if not isinstance(ent, dict):
        return None
    filtered = {
        k: v for k, v in ent.items()
        if not k.startswith("com.apple.developer.")
        and k not in ("keychain-access-groups", "com.apple.application-identifier")
    }
    return plistlib.dumps(filtered) if filtered else None


def _extract_identifier(src_path):
    """Read the existing code-signing identifier (defaults to file basename).

    Signing the temp copy would otherwise bake in "<name>.tmp.<pid>" as the
    identifier, which changes the code identity that TCC and the keychain
    bind to (the desktop backend is signed as "language_server", not
    "language_server.tmp.35559").
    """
    if sys.platform != "darwin" or not os.path.exists(src_path):
        return None
    res = subprocess.run(["codesign", "-d", "--verbose=2", src_path],
                         capture_output=True, text=True)
    # codesign writes its description to stderr.
    m = re.search(r"^Identifier=(.+)$", res.stderr or res.stdout, re.M)
    return m.group(1).strip() if m else None


def resign(path, entitlements_xml=None, identifier=None):
    if sys.platform != "darwin":
        print("[i] non-macOS host: skipping codesign")
        return
    ent_file = None
    try:
        cmd = ["codesign", "--force", "--sign", "-", "--options", "runtime"]
        if identifier:
            cmd.extend(["--identifier", identifier])
        if entitlements_xml:
            fd, ent_file = tempfile.mkstemp(suffix=".entitlements.plist")
            os.write(fd, entitlements_xml)
            os.close(fd)
            cmd.extend(["--entitlements", ent_file])
        cmd.append(path)
        subprocess.run(cmd, check=True, capture_output=True)
        subprocess.run(
            ["codesign", "--verify", "--verbose=1", path],
            check=True,
            capture_output=True,
        )
    finally:
        if ent_file and os.path.exists(ent_file):
            os.unlink(ent_file)


def write_atomic_signed(dst, data, src_for_entitlements=None, make_backup=False):
    """Write to a fresh inode, sign, then os.replace() to refresh macOS cs_blob cache."""
    ent_xml = _extract_adhoc_safe_entitlements(src_for_entitlements or dst)
    ident = _extract_identifier(src_for_entitlements or dst)
    if make_backup and os.path.exists(dst):
        bak = dst + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
            print(f"[i] saved backup: {bak}")

    tmp = f"{dst}.tmp.{os.getpid()}"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        if sys.platform != "win32":
            os.chmod(tmp, 0o755)
        resign(tmp, entitlements_xml=ent_xml, identifier=ident)
        try:
            os.replace(tmp, dst)
        except OSError:
            if sys.platform == "win32":
                # On Windows, if dst is running, direct replace might fail with WinError 32 or 5.
                # A running Windows executable can be renamed away first:
                old = f"{dst}.old.{os.getpid()}"
                try:
                    os.rename(dst, old)
                    os.rename(tmp, dst)
                except Exception:
                    raise
            else:
                raise
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

    if ident:
        print(f"[i] signature: identifier preserved as {ident!r}")
    if sys.platform == "darwin" and ".app/Contents/" in dst:
        print("[!] target lives inside an .app bundle: the bundle's sealed "
              "resources no longer verify\n"
              "    (codesign --verify --deep <app> now fails; the app still "
              "launches, at your own risk).")
        if os.path.exists(dst + ".bak"):
            print(f"    restore: cp -p '{dst}.bak' '{dst}'")


def main():
    ap = argparse.ArgumentParser(
        description="Unlock all 3 context-window gates in agy CLI."
    )
    ap.add_argument("--binary", default=os.path.expanduser("~/.local/bin/agy"))
    ap.add_argument("--no-env-fix", action="store_true",
                    help="skip optional AGY_CLI_AUTO_COMPACT_OVERRIDE restore")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip creating <binary>.bak on --in-place")
    ap.add_argument("--limit", type=int, default=None,
                    help="target token limit clamp in utils.GetCheckpointConfig (e.g. 512000, 900000; 0 for unlimited)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--locate", action="store_true", help="print target symbols only")
    args = ap.parse_args()

    src = os.path.abspath(os.path.expanduser(args.binary))
    if not os.path.exists(src):
        sys.exit(f"error: no such file: {src}")

    with open(src, "rb") as fh:
        data = bytearray(fh.read())
    before = hashlib.sha256(data).hexdigest()

    if sys.platform != "win32":
        running = subprocess.run(["pgrep", "-f", src], capture_output=True, text=True)
        pids = [p for p in running.stdout.split() if p != str(os.getpid())]
        if pids:
            print(f"[!] {len(pids)} process(es) are running this binary "
                  f"(pid {', '.join(pids[:5])}); quit them first or the running "
                  f"copy keeps executing the old code")

    text_va, text_off, arch = find_text_section(data)
    funcs = build_functions(bytes(data))
    print(f"[i] binary : {src}")
    print(f"[i] target : arch={arch} text_va={text_va:#x} text_off={text_off:#x} "
          f"symbols={len(funcs)}")

    inspect_syms = (
        FUNC_OFFERS,
        FUNC_STORE_CW,
        FUNC_STORE_CHOICE,
        FUNC_CHECKPOINT,
        FUNC_EXP_CHECKPOINT,
        FUNC_OVERRIDE,
        "strings.TrimSpace",
        "os.Getenv",
    )
    for key in inspect_syms:
        if key in funcs:
            eoff, sz = funcs[key]
            print(f"[i] symbol : {key} -> {text_va + eoff:#x} (size={sz:#x})")
        else:
            print(f"[i] symbol : {key} -> MISSING")

    if args.locate:
        return

    is_server_only = (FUNC_OFFERS not in funcs and FUNC_STORE_CW not in funcs)
    if is_server_only:
        print("[i] mode   : standalone language_server (Gate 3A + Gate 3B)")
        patch_pipeline = (patch_gate3a_checkpoint, patch_gate3b_exp_checkpoint)
    else:
        patch_pipeline = (
            patch_gate1_ui,
            patch_gate2_store,
            patch_gate3a_checkpoint,
            patch_gate3b_exp_checkpoint,
        )

    for patch_fn in patch_pipeline:
        if patch_fn == patch_gate3a_checkpoint:
            changed, msg = patch_fn(data, funcs, text_va, text_off, arch, target_limit=args.limit)
        else:
            changed, msg = patch_fn(data, funcs, text_va, text_off, arch)
        print(("[*] " if changed else "[=] ") + msg)

    if not is_server_only and not args.no_env_fix:
        try:
            changed, msg = patch_env(data, funcs, text_va, text_off, arch)
            print(("[*] " if changed else "[=] ") + msg)
        except PatchError as exc:
            print(f"[!] skipped optional env-var patch: {exc}")

    after = hashlib.sha256(bytes(data)).hexdigest()
    if before == after:
        print("[=] all gates already unlocked; nothing to write")
        return
    if args.dry_run:
        print(f"[*] dry run complete: sha256 {before[:12]} -> {after[:12]}")
        return

    dst = src if args.in_place else src + ".patched"
    write_atomic_signed(
        dst,
        data,
        src_for_entitlements=src,
        make_backup=(args.in_place and not args.no_backup),
    )
    final_sha = hashlib.sha256(open(dst, "rb").read()).hexdigest()
    print(f"[*] wrote  : {dst}\n    sha256 : {before[:12]} -> {final_sha[:12]}")


if __name__ == "__main__":
    try:
        main()
    except PatchError as exc:
        sys.exit(f"error: {exc}")
