const axios = require('axios');
const FormData = require('form-data');

const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'llama-3.1-8b-instant';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'llama-3.3-70b-versatile';

async function chat(messages) {
    const providers = [
        ['https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, MODEL],
        ['https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, FALLBACK_MODEL],
        ['https://openrouter.ai/api/v1/chat/completions', OPENROUTER_KEY, 'meta-llama/llama-3.1-8b-instant:free'],
    ];

    for (const [url, key, model] of providers) {
        if (!key) continue;
        try {
            const { data } = await axios.post(url,
                { model, messages, max_tokens: 400 },
                { headers: { Authorization: `Bearer ${key}` }, timeout: 25000 }
            );
            const text = data?.choices?.[0]?.message?.content;
            if (text) return text.trim();
        } catch (e) {
            console.warn(`chat ${model}: ${e.message}`);
        }
    }
    return null;
}

async function transcribe(audioBuffer) {
    const ext = 'ogg';
    const mimeMap = {
        ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg',
        mp4: 'audio/mp4', m4a: 'audio/mp4', wav: 'audio/wav',
        flac: 'audio/flac', webm: 'audio/webm', mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
    };

    for (const model of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
        try {
            const form = new FormData();
            form.append('file', audioBuffer, {
                filename: `audio.${ext}`,
                contentType: mimeMap[ext] || 'audio/ogg',
            });
            form.append('model', model);
            form.append('language', 'es');

            const { data } = await axios.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                form,
                {
                    headers: { ...form.getHeaders(), Authorization: `Bearer ${GROQ_KEY}` },
                    timeout: 60000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                }
            );
            if (data?.text) return data.text.trim();
        } catch (e) {
            console.warn(`whisper ${model}: ${e.message}`);
        }
    }
    return '';
}

module.exports = { chat, transcribe };
