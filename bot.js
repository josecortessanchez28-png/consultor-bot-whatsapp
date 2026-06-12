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

async function handleMessage(jid, text) {
    try {
        const history = await database.getRecentMessages(jid, 15);

        const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
        for (const [role, content] of history) {
            messages.push({ role, content });
        }
        messages.push({ role: 'user', content: text });

        await database.saveMessage(jid, 'user', text);

        const resp = await groq.chat(messages) || 'No pude generar respuesta ahora. Intenta de nuevo.';

        await database.saveMessage(jid, 'assistant', resp);
        return resp;
    } catch (e) {
        console.error('handleMessage:', e);
        return 'Error interno. Intenta de nuevo.';
    }
}

async function transcribeAudio(buffer) {
    return await groq.transcribe(buffer);
}

module.exports = { handleMessage, transcribeAudio };
