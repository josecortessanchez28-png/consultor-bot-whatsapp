const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const archiver = require('archiver');
const unzipper = require('unzipper');

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }

    async saveSession(key, sourceDir) {
        const exists = await fs.pathExists(sourceDir);
        if (!exists) {
            console.log('[SupabaseStore] sourceDir no existe');
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

            const { error } = await this.db
                .from('sessions')
                .upsert({ key, data: b64, updated_at: new Date().toISOString() }, { onConflict: 'key' });

            if (error) {
                console.log('[SupabaseStore] DB upsert error:', error.message);
                return;
            }

            console.log(`[SupabaseStore] Sesión guardada en BD (${(buffer.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.log('[SupabaseStore] saveSession error:', e.message);
        } finally {
            await fs.remove(tmpPath).catch(() => {});
        }
    }

    async restoreSession(key, destDir) {
        try {
            const { data, error } = await this.db
                .from('sessions')
                .select('data')
                .eq('key', key)
                .single();

            if (error || !data) {
                console.log('[SupabaseStore] DB select error:', error?.message || 'no data');
                return false;
            }

            const buffer = Buffer.from(data.data, 'base64');
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
                console.log(`[SupabaseStore] Sesión restaurada desde BD (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            } finally {
                await fs.remove(tmpPath).catch(() => {});
            }
        } catch (e) {
            console.log('[SupabaseStore] restoreSession error:', e.message);
            return false;
        }
    }

    async sessionExists(key) {
        try {
            const { data, error } = await this.db
                .from('sessions')
                .select('key')
                .eq('key', key)
                .maybeSingle();
            return !error && !!data;
        } catch {
            return false;
        }
    }
}

module.exports = SupabaseStore;
