const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const CHAPTERS = [
    'Capítulo 1: Bienvenido a la campaña. Hoy hablaremos de la visión del proyecto y cómo puedes acompañar cada día.',
    'Capítulo 2: La historia de la misión y la importancia de la comunidad. Aprende a vivir la fe en familia.',
    'Capítulo 3: Compartiendo esperanza a través del servicio y la oración. Encuentra un propósito claro hoy.',
    'Capítulo 4: Cómo mantener el compromiso espiritual y recibir apoyo de tu pastor.',
    'Capítulo 5: El siguiente paso para tu crecimiento espiritual y cómo ser parte activa de la campaña.'
];

function getSupabaseClient() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('SUPABASE_URL y SUPABASE_KEY son necesarios.');
    }
    return createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false }
    });
}

function isToday(timestamp) {
    if (!timestamp) return false;
    const now = new Date();
    const date = new Date(timestamp);
    return now.toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
}

function getDailyChapter(user) {
    const chapterNumber = Number(user.capitulo_actual) || 1;
    const index = Math.max(0, Math.min(chapterNumber - 1, CHAPTERS.length - 1));
    return CHAPTERS[index];
}

async function sendWhatsAppMessage(phoneNumberId, payload) {
    if (!WHATSAPP_TOKEN) {
        throw new Error('WHATSAPP_TOKEN no configurado.');
    }

    const url = `https://graph.facebook.com/v26.0/${phoneNumberId}/messages`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`HTTP ${response.status} - ${errorData}`);
    }
}

async function updateUsuario(userId, updates) {
    const supabase = getSupabaseClient();
    const { error } = await supabase
        .from('usuarios_campana')
        .update(updates)
        .eq('id', userId);

    if (error) {
        console.error('Supabase error updateUsuario:', error.message);
        throw error;
    }
}

app.get('/', async (req, res) => {
    try {
        if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
            return res.sendStatus(403);
        }

        if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
            return res.status(500).send('CONFIGURATION_ERROR');
        }

        const supabase = getSupabaseClient();
        const { data: users, error } = await supabase
            .from('usuarios_campana')
            .select('*')
            .eq('estado', 'activo_serie');

        if (error) {
            console.error('Supabase error fetching users:', error.message);
            return res.status(500).send('SUPABASE_ERROR');
        }

        let sent = 0;
        let skipped = 0;

        for (const user of users || []) {
            if (!user.telefono || isToday(user.ultimo_envio)) {
                skipped++;
                continue;
            }

            const chapterText = getDailyChapter(user);
            await sendWhatsAppMessage(WHATSAPP_PHONE_NUMBER_ID, {
                messaging_product: 'whatsapp',
                to: user.telefono,
                type: 'text',
                text: { body: chapterText }
            });

            await updateUsuario(user.id, {
                ultimo_envio: new Date().toISOString(),
                capitulo_actual: (Number(user.capitulo_actual) || 1) + 1
            });
            sent++;
        }

        return res.status(200).json({ sent, skipped });
    } catch (error) {
        console.error('cron-serie error:', error);
        return res.status(500).send('CRON_ERROR');
    }
});

module.exports = app;
