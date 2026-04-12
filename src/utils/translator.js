import settings from '../agent/settings.js';

// Lazy-load google-translate-api-x only when translation is actually needed.
// For English-only use, this avoids importing the module entirely — saving
// startup time and eliminating async overhead on every message.
let translate = null;
async function getTranslator() {
    if (!translate) {
        const mod = await import('google-translate-api-x');
        translate = mod.default;
    }
    return translate;
}

function isEnglish() {
    const lang = String(settings.language).toLowerCase();
    return !lang || lang === 'en' || lang === 'english';
}

export async function handleTranslation(message) {
    if (isEnglish()) return message;
    try {
        const t = await getTranslator();
        const translation = await t(message, { to: String(settings.language) });
        return translation.text || message;
    } catch (error) {
        console.error('Error translating message:', error);
        return message;
    }
}

export async function handleEnglishTranslation(message) {
    if (isEnglish()) return message;
    try {
        const t = await getTranslator();
        const translation = await t(message, { to: 'english' });
        return translation.text || message;
    } catch (error) {
        console.error('Error translating message:', error);
        return message;
    }
}
