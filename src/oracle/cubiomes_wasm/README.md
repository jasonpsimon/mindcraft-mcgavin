# cubiomes_wasm

Vendored WebAssembly build of [cubiomes](https://github.com/Cubitect/cubiomes)
for the BT-7f Structure Oracle.

## Artifacts

| file                   | purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `cubiomes_oracle.wasm` | compiled cubiomes + oracle_driver.c (~19 KB)                   |
| `cubiomes_oracle.js`   | emscripten module glue, imported by structure_oracle.js        |
| `oracle_driver.c`      | minimal C driver exposing `findNearestStructure` et al.        |

## Rebuild recipe

Pinned versions:

- `emsdk` **5.0.6**
- `cubiomes` HEAD **e61f905** (April 2026)
- emcc flags as shown below

### 1. Install emsdk (one-time)

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install 5.0.6
./emsdk activate 5.0.6
source ./emsdk_env.sh
```

### 2. Fetch cubiomes at pinned SHA

```bash
git clone https://github.com/Cubitect/cubiomes.git
cd cubiomes
git checkout e61f90580cbdd883214a8054670dacae655e59c0
```

### 3. Copy `oracle_driver.c` into the cubiomes source dir

```bash
cp /path/to/mindcraft-mcgavin/src/oracle/cubiomes_wasm/oracle_driver.c .
```

### 4. Compile

```bash
emcc -O2 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=CubiomesModule \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s 'EXPORTED_FUNCTIONS=["_findNearestStructure","_oracleResultX","_oracleResultZ","_selfTest"]' \
  -s 'EXPORTED_RUNTIME_METHODS=["ccall","cwrap"]' \
  biomes.c biomenoise.c finders.c generator.c layers.c noise.c quadbase.c oracle_driver.c \
  -o cubiomes_oracle.js
```

This produces `cubiomes_oracle.js` (glue, ~11 KB) and `cubiomes_oracle.wasm`
(~19 KB). Copy both into this directory alongside `oracle_driver.c`.

### 5. Smoke test (optional)

```js
// smoke_test.cjs
const CubiomesModule = require('./cubiomes_oracle.js');
CubiomesModule().then((m) => {
    const selfTest = m.cwrap('selfTest', 'number', []);
    console.log('selfTest:', selfTest()); // expect 4242
});
```

## Regenerating after cubiomes upstream changes

If cubiomes introduces a new MC version enum value or renames a structure,
update the following in `src/oracle/structure_oracle.js`:

- `MC_VERSION_IDS` table — append new `'X.Y.Z': <enum>` entry.
- `STRUCTURE_IDS` table — append new structure mapping.

Both tables are authored from the compiled `biomes.h` / `finders.h` enums.
Use a one-off C probe (see `tests/oracle/enum_probe.c` if present) to read
enum values from a specific cubiomes SHA.

## Why we vendor

- cubiomes is pure C with no runtime dependencies — vendoring a WASM build is
  ~30 KB combined and requires no npm install.
- Rebuild is a one-command operation that only our maintainers need to run.
- Keeping the pinned SHA in this README makes drift detection trivial.
