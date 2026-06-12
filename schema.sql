-- Tabla para historial de conversaciones
CREATE TABLE IF NOT EXISTS conversaciones (
    id BIGSERIAL PRIMARY KEY,
    whatsapp_id TEXT NOT NULL,
    rol TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversaciones_whatsapp_id ON conversaciones (whatsapp_id);

-- Tabla para persistencia de sesión WhatsApp (reemplaza a Storage)
CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
