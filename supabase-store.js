const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const archiver = require('archiver');
const unzipper = require('unzipper');

const SESSION_WA = '__session__';

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }

    async _hasSessionRow() {
        const { data, error } = await this.db
            .from('conversaciones')
            .select('id')
            .eq('whatsapp_id', SESSION_WA)
            .limit(1);
        return !error && (data?.length || 0) > 0;
    }

    async saveSession(key, sourceDir) {
        const exists = await fs.pathExists(sourceDir);
        if (!exists) {
            console.log('[Store] sourceDir no existe');
            return;
        }

        const tmpPath = path.join(os.tmpdir(), `sess-${key}`);
        try {
            await new Promise((resolve, reject) => {
                const output = fs.createWriteStream(tmpPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                output.on('close', resolve);
                archive.on('error', reject);
                archive.pipe(output);
                archive.directory(sourceDir, 'session-consultor-bot');
                archive.finalize();
            });

            const buffer = await fs.readFile(tmpPath);
            const b64 = buffer.toString('base64');

            // Remove old session row
            await this.db
                .from('conversaciones')
                .delete()
                .eq('whatsapp_id', SESSION_WA);

            // Insert new
            const { error } = await this.db
                .from('conversaciones')
                .insert({ whatsapp_id: SESSION_WA, rol: key, mensaje: b64 });

            if (error) {
                console.log('[Store] insert error:', error.message);
                return;
            }

            console.log(`[Store] Sesión guardada en conversaciones (${(buffer.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.log('[Store] saveSession error:', e.message);
        } finally {
            await fs.remove(tmpPath).catch(() => {});
        }
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

            if (error || !data?.length) {
                console.log('[Store] No hay sesión guardada');
                return false;
            }

            const b64 = data[0].mensaje;
            const buffer = Buffer.from(b64, 'base64');
            const tmpPath = path.join(os.tmpdir(), `sess-${key}`);

            try {
                await fs.writeFile(tmpPath, buffer);
                await fs.ensureDir(destDir);
                await new Promise((resolve, reject) => {
                    fs.createReadStream(tmpPath)
                        .pipe(unzipper.Extract({ path: destDir }))
                        .on('close', resolve)
                        .on('error', reject);
                });
                console.log(`[Store] Sesión restaurada desde conversaciones (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            } finally {
                await fs.remove(tmpPath).catch(() => {});
            }
        } catch (e) {
            console.log('[Store] restoreSession error:', e.message);
            return false;
        }
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
        } catch {
            return false;
        }
    }
}

module.exports = SupabaseStore;
