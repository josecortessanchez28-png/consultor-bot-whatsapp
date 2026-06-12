const { createClient } = require('@supabase/supabase-js');
const fs = require('fs-extra');
const path = require('path');

const SESSION_WA = '__session__';

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }

    async _serializeDir(dirPath, prefix = '') {
        const result = {};
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                Object.assign(result, await this._serializeDir(fullPath, relPath));
            } else if (entry.isFile()) {
                result[relPath] = (await fs.readFile(fullPath)).toString('base64');
            }
        }
        return result;
    }

    async _deserializeDir(dirPath, data) {
        await fs.ensureDir(dirPath);
        for (const [relPath, b64] of Object.entries(data)) {
            const fullPath = path.join(dirPath, relPath);
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, Buffer.from(b64, 'base64'));
        }
    }

    async saveSession(key, sourceDir) {
        if (!await fs.pathExists(sourceDir)) return;
        try {
            const data = await this._serializeDir(sourceDir);
            const json = JSON.stringify(data);
            await this.db.from('conversaciones').delete().eq('whatsapp_id', SESSION_WA);
            const { error } = await this.db.from('conversaciones').insert({
                whatsapp_id: SESSION_WA, rol: key, mensaje: json,
            });
            if (error) { console.log('[Store] insert error:', error.message); return; }
            console.log(`[Store] Sesión guardada (${(json.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(data).length} archivos)`);
        } catch (e) { console.log('[Store] saveSession error:', e.message); }
    }

    async restoreSession(key, destDir) {
        try {
            const { data, error } = await this.db
                .from('conversaciones')
                .select('mensaje')
                .eq('whatsapp_id', SESSION_WA)
                .eq('rol', key)
                .order('created_at', { ascending: false })
                .limit(1);
            if (error || !data?.length) return false;
            const parsed = JSON.parse(data[0].mensaje);
            await this._deserializeDir(destDir, parsed);
            console.log(`[Store] Sesión restaurada (${Object.keys(parsed).length} archivos)`);
            return true;
        } catch (e) { console.log('[Store] restoreSession error:', e.message); return false; }
    }

    async sessionExists(key) {
        try {
            const { data, error } = await this.db
                .from('conversaciones')
                .select('id')
                .eq('whatsapp_id', SESSION_WA)
                .eq('rol', key)
                .limit(1);
            return !error && (data?.length || 0) > 0;
        } catch { return false; }
    }
}

module.exports = SupabaseStore;
