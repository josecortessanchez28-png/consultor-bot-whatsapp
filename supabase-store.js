const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BUCKET = 'session-bucket';

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }

    async _ensureBucket() {
        const { data: buckets, error } = await this.db.storage.listBuckets();
        if (error) return console.log('[Store] listBuckets error:', error.message);
        if (!buckets?.find(b => b.name === BUCKET)) {
            const { error: ce } = await this.db.storage.createBucket(BUCKET, { public: false });
            if (ce) console.log('[Store] createBucket error:', ce.message);
            else console.log('[Store] Bucket creado:', BUCKET);
        }
    }

    async saveSession(key, sourceDir) {
        if (!fs.existsSync(sourceDir)) {
            return console.log('[Store] sourceDir no existe:', sourceDir);
        }
        const tmpFile = path.join(sourceDir, '..', `session-${key}.tar`);
        const parentDir = path.dirname(sourceDir);
        const dirName = path.basename(sourceDir);
        try {
            console.log('[Store] tar...');
            execFileSync('tar', ['-cf', tmpFile, '-C', parentDir, dirName], { stdio: 'pipe', timeout: 120000 });
            const stat = fs.statSync(tmpFile);
            console.log('[Store] tar creado:', (stat.size / 1024).toFixed(0), 'KB');

            const buffer = fs.readFileSync(tmpFile);
            await this._ensureBucket();
            const { error } = await this.db.storage.from(BUCKET).upload(`${key}.tar`, buffer, {
                upsert: true,
            });
            if (error) return console.log('[Store] Storage upload error:', error.message);
            console.log('[Store] Sesión guardada');
        } catch (e) {
            console.log('[Store] saveSession error:', e.message);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async restoreSession(key, destDir) {
        const tmpFile = path.join(destDir, `session-${key}.tar`);
        try {
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).download(`${key}.tar`);
            if (error || !data) {
                return console.log('[Store] No hay sesión en Storage') || false;
            }
            const buffer = Buffer.from(await data.arrayBuffer());
            fs.writeFileSync(tmpFile, buffer);
            console.log('[Store] Descargado:', (buffer.length / 1024).toFixed(0), 'KB');

            execFileSync('tar', ['-xf', tmpFile, '-C', destDir], { stdio: 'pipe', timeout: 120000 });
            console.log('[Store] Sesión restaurada');
            return true;
        } catch (e) {
            console.log('[Store] restoreSession error:', e.message);
            return false;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async sessionExists(key) {
        try {
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).list('', { search: `${key}.tar` });
            return !error && !!data?.length;
        } catch { return false; }
    }
}

module.exports = SupabaseStore;
