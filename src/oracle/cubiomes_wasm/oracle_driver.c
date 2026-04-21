// Minimal feasibility driver — exposes cubiomes structure-finding to JS via
// emscripten. Purpose: prove cubiomes→WASM→Node round-trip with zero source
// patches to cubiomes itself.
//
// Caller provides seed as two 32-bit halves (hi, lo) because JS BigInt marshal
// is messy across emscripten. Results are read via out-accessors after each
// findNearestStructure call — simpler than packing via memory.

#include <emscripten.h>
#include "generator.h"
#include "finders.h"

static Pos g_lastPos;
static int g_lastFound;

EMSCRIPTEN_KEEPALIVE
int findNearestStructure(int structureType, int mcVersion,
                         unsigned int seedLo, unsigned int seedHi,
                         int blockX, int blockZ, int searchRadiusRegions)
{
    uint64_t seed = ((uint64_t)seedHi << 32) | (uint64_t)seedLo;
    StructureConfig sconf;
    if (!getStructureConfig(structureType, mcVersion, &sconf)) {
        g_lastFound = 0;
        return 0;
    }
    int regionSize = sconf.regionSize * 16; // blocks per region side
    int regX0 = blockX / regionSize;
    int regZ0 = blockZ / regionSize;

    Pos bestPos = {0, 0};
    long bestDist = -1;

    for (int dz = -searchRadiusRegions; dz <= searchRadiusRegions; dz++) {
        for (int dx = -searchRadiusRegions; dx <= searchRadiusRegions; dx++) {
            Pos p;
            if (!getStructurePos(structureType, mcVersion, seed,
                                 regX0 + dx, regZ0 + dz, &p)) {
                continue;
            }
            long ddx = (long)p.x - blockX;
            long ddz = (long)p.z - blockZ;
            long d = ddx * ddx + ddz * ddz;
            if (bestDist < 0 || d < bestDist) {
                bestDist = d;
                bestPos = p;
            }
        }
    }

    if (bestDist < 0) {
        g_lastFound = 0;
        return 0;
    }
    g_lastPos = bestPos;
    g_lastFound = 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int oracleResultX(void) { return g_lastFound ? g_lastPos.x : 0; }
EMSCRIPTEN_KEEPALIVE int oracleResultZ(void) { return g_lastFound ? g_lastPos.z : 0; }
EMSCRIPTEN_KEEPALIVE int selfTest(void) { return 4242; }
