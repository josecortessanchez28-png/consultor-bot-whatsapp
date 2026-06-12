const database = require('./database');
const groq = require('./groq');

const SYSTEM_PROMPT = (
    'Eres un consultor experto en IA y automatización de procesos de negocio. ' +
    'Tu misión es encontrar la automatización o el agente de IA perfecto para Adrián y sus negocios. ' +
    'Reglas estrictas:\n' +
    '1. Responde SIEMPRE en una o dos frases cortas, estilo WhatsApp. Prohibidos los párrafos.\n' +
    '2. Haz solo UNA pregunta estratégica a la vez. Espera su respuesta antes de avanzar.\n' +
    '3. Sé empático y traduce conceptos técnicos a utilidad real.\n' +
    '4. Cuando acumules suficiente información sobre un problema, PROPÓN formalmente una solución técnica concreta.\n' +
    '5. Si te envía un audio, ya viene transcrito como texto. Responde al contenido.'
);

async function handleMessage(client, msg) {
    try {
        const waId = msg.from;
        let text = '';

        if (msg.body && !msg.hasMedia) {
            text = msg.body.trim();
        } else if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
            const media = await msg.downloadMedia();
            if (!media || !media.data) {
                await client.sendMessage(waId, 'No pude descargar el audio.');
                return;
            }
            await client.sendMessage(waId, 'Transcribiendo audio...');
            text = await groq.transcribe(media.data, media.filename || 'audio.ogg');
            if (!text) {
                await client.sendMessage(waId, 'No entendí el audio.');
                return;
            }
        }

        if (!text) return;

        const history = await database.getRecentMessages(waId, 15);

        const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
        for (const [role, content] of history) {
            messages.push({ role, content });
        }
        messages.push({ role: 'user', content: text });

        await database.saveMessage(waId, 'user', text);

        const resp = await groq.chat(messages) || 'No pude generar respuesta ahora. Intenta de nuevo.';

        await database.saveMessage(waId, 'assistant', resp);
        await client.sendMessage(waId, resp);
    } catch (e) {
        console.error('handleMessage:', e);
    }
}

module.exports = { handleMessage };
