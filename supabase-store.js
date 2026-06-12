const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUCKET = 'session-bucket';

class SupabaseStore {
    constructor() {
        const key = process.env.SUPABASE_KEY;
        this.db = createClient(process.env.SUPABASE_URL, key);
        this.serviceKey = key;
    }

    async _ensureBucket() {
        try {
            const { data: buckets, error } = await this.db.storage.listBuckets();
            if (error) {
                console.log('[Store] listBuckets error:', error.message);
                return;
            }
            if (!buckets?.find(b => b.name === BUCKET)) {
                const { error: ce } = await this.db.storage.createBucket(BUCKET, { public: false });
                if (ce) console.log('[Store] createBucket error:', ce.message);
                else console.log('[Store] Bucket creado:', BUCKET);
            }
        } catch (e) {
            console.log('[Store] _ensureBucket error:', e.message);
        }
    }

    async saveSession(key, sourceDir) {
        if (!fs.existsSync(sourceDir)) {
            console.log('[Store] sourceDir no existe:', sourceDir);
            return;
        }
        const tmpFile = path.join(os.tmpdir(), `session-${key}.tar.gz`);
        const parentDir = path.dirname(sourceDir);
        const dirName = path.basename(sourceDir);
        try {
            console.log('[Store] Comprimiendo con tar...');
            execSync(`tar -czf "${tmpFile}" -C "${parentDir}" "${dirName}"`, { stdio: 'pipe', timeout: 30000 });
            const stat = fs.statSync(tmpFile);
            console.log('[Store] tar.gz creado:', (stat.size / 1024).toFixed(0), 'KB');

            const buffer = fs.readFileSync(tmpFile);
            await this._ensureBucket();
            const { error } = await this.db.storage.from(BUCKET).upload(`${key}.tar.gz`, buffer, {
                contentType: 'application/gzip',
                upsert: true,
            });
            if (error) {
                console.log('[Store] Storage upload error:', error.message);
                return;
            }
            console.log(`[Store] Sesión guardada en Storage (${(stat.size / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.log('[Store] saveSession error:', e.message);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async restoreSession(key, destDir) {
        const tmpFile = path.join(os.tmpdir(), `session-${key}.tar.gz`);
        try {
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).download(`${key}.tar.gz`);
            if (error || !data) {
                console.log('[Store] No hay sesión en Storage');
                return false;
            }
            const buffer = Buffer.from(await data.arrayBuffer());
            fs.writeFileSync(tmpFile, buffer);
            console.log('[Store] Descargado:', (buffer.length / 1024).toFixed(0), 'KB');

            fs.mkdirSync(destDir, { recursive: true });
            execSync(`tar -xzf "${tmpFile}" -C "${destDir}"`, { stdio: 'pipe', timeout: 30000 });
            console.log('[Store] Sesión restaurada desde Storage');
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
            const { data, error } = await this.db.storage.from(BUCKET).list('', { search: `${key}.tar.gz` });
            return !error && !!data?.length;
        } catch { return false; }
    }
}

module.exports = SupabaseStore;
