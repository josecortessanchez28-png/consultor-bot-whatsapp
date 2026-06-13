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

const INSTANCE_ID = Math.random().toString(36).substring(2, 15);

async function updateHeartbeat() {
    try {
        await db.from('sessions').upsert({
            key: 'heartbeat',
            data: JSON.stringify({
                instanceId: INSTANCE_ID,
                timestamp: Date.now()
            })
        });
    } catch (e) {
        console.error('updateHeartbeat error:', e.message);
    }
}

async function getActiveInstance() {
    try {
        const { data, error } = await db.from('sessions').select('data').eq('key', 'heartbeat');
        if (error || !data || data.length === 0) return null;
        return JSON.parse(data[0].data);
    } catch (e) {
        console.error('getActiveInstance error:', e.message);
        return null;
    }
}

async function releaseHeartbeat() {
    try {
        await db.from('sessions').delete().eq('key', 'heartbeat');
    } catch (e) {
        console.error('releaseHeartbeat error:', e.message);
    }
}

module.exports = { 
    saveMessage, 
    getRecentMessages, 
    INSTANCE_ID, 
    updateHeartbeat, 
    getActiveInstance, 
    releaseHeartbeat 
};
