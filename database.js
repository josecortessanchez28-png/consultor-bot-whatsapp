const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const db = createClient(supabaseUrl, supabaseKey);

async function saveMessage(waId, role, content) {
    try {
        await db.from('conversaciones').insert({
            whatsapp_id: waId,
            rol: role,
            mensaje: String(content).slice(0, 4000),
        });
    } catch (e) {
        console.error('saveMessage:', e);
    }
}

async function getRecentMessages(waId, limit = 15) {
    try {
        const { data } = await db
            .from('conversaciones')
            .select('rol, mensaje')
            .eq('whatsapp_id', waId)
            .order('created_at', { ascending: false })
            .limit(limit);

        const rows = data || [];
        rows.reverse();
        return rows.map(r => [r.rol, r.mensaje]);
    } catch (e) {
        console.error('getRecentMessages:', e);
        return [];
    }
}

module.exports = { saveMessage, getRecentMessages };
