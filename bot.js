const database = require('./database');
const groq = require('./groq');

const SYSTEM_PROMPT = (
    'Eres Asesos, un asistente personal de IA para Esther. ' +
    'Tu misión es ayudar a Esther a identificar problemas del día a día que puedan ' +
    'resolverse con automatización o inteligencia artificial.\n\n' +
    'Reglas:\n' +
    '1. Responde en español, breve y natural. Tono amable.\n' +
    '2. Si ves que la conversación está empezando, preséntate brevemente.\n' +
    '3. Haz solo UNA pregunta a la vez. Espera su respuesta antes de avanzar.\n' +
    '4. Sé empática y traduce conceptos técnicos a utilidad real para su día a día.\n' +
    '5. Cuando tengas suficiente información sobre un problema, PROPÓN una solución con IA concreta.\n' +
    '6. No te repitas. Si ya te presentaste, no lo hagas de nuevo.'
);

async function handleMessage(bot, msg) {
    const chatId = String(msg.chat?.id || '');
    const userId = String(msg.from?.id || '');
    if (!chatId || !userId) return;

    try {
        let text = (msg.text || '').trim();

        if (!text && msg.voice) {
            try {
                await bot.sendMessage(chatId, 'Transcribiendo audio...');
                const link = await bot.getFileLink(msg.voice.file_id);
                const resp = await fetch(link);
                const buffer = Buffer.from(await resp.arrayBuffer());
                const b64 = buffer.toString('base64');
                text = await groq.transcribe(b64, 'audio.ogg');
                if (!text) text = '';
            } catch (e) {
                console.error('Audio transcribe error:', e.message);
            }
        }

        if (!text) {
            console.log('Mensaje sin texto, ignorando');
            return;
        }

        let history = [];
        try { history = await database.getRecentMessages(userId, 15); } catch (_) {}

        const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
        for (const [role, content] of history) {
            messages.push({ role, content });
        }
        messages.push({ role: 'user', content: text });

        try { await database.saveMessage(userId, 'user', text); } catch (_) {}

        const resp = await groq.chat(messages);
        const reply = resp || 'No pude generar respuesta ahora. Intenta de nuevo.';

        try { await database.saveMessage(userId, 'assistant', reply); } catch (_) {}
        await bot.sendMessage(chatId, reply);
    } catch (e) {
        console.error('handleMessage error:', e.message);
        try { await bot.sendMessage(chatId, 'Ocurrió un error al procesar tu mensaje.'); } catch (_) {}
    }
}

module.exports = { handleMessage };
