// src/oracle/seed_discovery.js
//
// Discovers the active world's seed and MC version by reading the server's
// level.dat NBT file. This allows the Structure Oracle (cubiomes-WASM) to
// resolve structure positions without user-provided seed input on setups
// where the bot process shares a filesystem with the server.
//
// Graceful failure is mandatory: returns null if level.dat cannot be located
// or parsed, so callers can disable downstream features without crashing.
//
// Priority order for candidate world directories:
//   1. Explicit opts.worldPath (typically from profile.worldPath)
//   2. Common candidate paths relative to process.cwd():
//        ./world, ../world, ./minecraft/world, ../minecraft/world
//
// Seed field lookup order inside level.dat:
//   1. Data.WorldGenSettings.seed (modern 1.16+)
//   2. Data.RandomSeed (legacy pre-1.16 fallback)
//
// The returned seed is a BigInt (64-bit signed interpreted as unsigned for
// cubiomes). The returned mc_version string mirrors Data.Version.Name
// (e.g., "1.21" or "1.21.4").
//
// No secret is ever logged by this module. The seed value is sensitive and
// only returned to the caller — consumers must decide where it can flow.

import fs from 'fs';
import path from 'path';
import nbt from 'prismarine-nbt';

const CANDIDATE_RELATIVE_PATHS = [
    './world',
    '../world',
    './minecraft/world',
    '../minecraft/world',
];

function longToBigInt(longVal) {
    // prismarine-nbt returns longs as [hi, lo] int32 pairs across most versions.
    // Some newer builds emit BigInt directly; handle both.
    if (typeof longVal === 'bigint') return longVal;
    if (Array.isArray(longVal) && longVal.length === 2) {
        const [hi, lo] = longVal;
        // hi is signed int32; lo must be treated unsigned for correct 64-bit assembly.
        const hiBig = BigInt(hi | 0);
        const loBig = BigInt(lo >>> 0);
        return (hiBig << 32n) | loBig;
    }
    if (typeof longVal === 'number') return BigInt(longVal);
    if (typeof longVal === 'string') return BigInt(longVal);
    throw new Error('unrecognized NBT long shape: ' + JSON.stringify(longVal));
}

async function tryReadLevelDat(worldDir) {
    const levelDat = path.join(worldDir, 'level.dat');
    if (!fs.existsSync(levelDat)) return null;
    let buf;
    try {
        buf = fs.readFileSync(levelDat);
    } catch (e) {
        return null;
    }
    let parsedRoot;
    try {
        const parsed = await nbt.parse(buf);
        parsedRoot = parsed.parsed;
    } catch (e) {
        return null;
    }
    const data = parsedRoot && parsedRoot.value && parsedRoot.value.Data
        ? parsedRoot.value.Data.value
        : null;
    if (!data) return null;

    // Seed discovery (two-path)
    let seedValue;
    let seedSource;
    const wgs = data.WorldGenSettings && data.WorldGenSettings.value;
    if (wgs && wgs.seed && wgs.seed.value !== undefined) {
        seedValue = wgs.seed.value;
        seedSource = 'WorldGenSettings.seed';
    } else if (data.RandomSeed && data.RandomSeed.value !== undefined) {
        seedValue = data.RandomSeed.value;
        seedSource = 'RandomSeed';
    } else {
        return null;
    }

    let seed;
    try {
        seed = longToBigInt(seedValue);
    } catch (e) {
        return null;
    }

    // MC version: Data.Version.Name (e.g., "1.21" or "1.21.4")
    let mcVersion = null;
    if (data.Version && data.Version.value && data.Version.value.Name) {
        mcVersion = data.Version.value.Name.value || null;
    }

    // Level name — not required, but useful for diagnostics (NOT the seed!)
    let levelName = null;
    if (data.LevelName && data.LevelName.value) {
        levelName = data.LevelName.value;
    }

    return {
        seed,
        mc_version: mcVersion,
        level_name: levelName,
        world_path: worldDir,
        source: 'level.dat:' + seedSource,
    };
}

export async function discoverWorldContext(opts) {
    const o = opts || {};
    const candidates = [];
    if (o.worldPath && typeof o.worldPath === 'string') {
        candidates.push(o.worldPath);
    }
    for (const rel of CANDIDATE_RELATIVE_PATHS) {
        candidates.push(path.resolve(process.cwd(), rel));
    }

    for (const dir of candidates) {
        try {
            const result = await tryReadLevelDat(dir);
            if (result) return result;
        } catch (e) {
            // next candidate
        }
    }
    return null;
}
