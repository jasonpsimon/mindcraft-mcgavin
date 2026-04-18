import { readFileSync } from 'fs';

let keys = {};
try {
    const data = readFileSync('./keys.json', 'utf8');
    keys = JSON.parse(data);
} catch (err) {
    // BT-bundle(c): prior message was always 'keys.json not found' regardless
    // of error class — a parse error (malformed JSON) looked identical to a
    // missing file. Branch on ENOENT so the two cases are distinguishable.
    if (err.code === 'ENOENT') {
        console.warn('keys.json not found. Defaulting to environment variables.'); // still works with local models
    } else {
        console.warn(`[Keys] keys.json read/parse failed: ${err.message}. Defaulting to environment variables.`);
    }
}

export function getKey(name) {
    let key = keys[name];
    if (!key) {
        key = process.env[name];
    }
    if (!key) {
        throw new Error(`API key "${name}" not found in keys.json or environment variables!`);
    }
    return key;
}

export function hasKey(name) {
    return keys[name] || process.env[name];
}
