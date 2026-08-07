const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Lista Oficial exacta (18 episodios)
const CHAPTERS = [
    'Serie 3EP1 - Cuando el cansancio ya no se ve',
    'Serie 3EP2 - Cuando el cansancio se vuelve rutina',
    'Serie 3EP3 - Cuando el alma sirve, pero no descansa',
    'Serie 3EP4 - Cuando el corazón no puede más',
    'Serie 3EP5 - Cuando el peso por fin se suelta',
    'Serie 3EP6 - Cuando el alma por fin descansa',
    'EP1 - Cuando el silencio pesa más que el ruido',
    'EP2 - Cuando la mente no se apaga',
    'EP3 - Cuando el corazón no encuentra calma',
    'EP4 - Cuando el futuro da miedo',
    'EP5 - Cuando la frustración pesa más que la esperanza',
    'EP6 - Cuando la entrega trae paz',
    'ES1 - Cuando nada tiene sentido',
    'ES2 - La soledad no es el final',
    'ES3 - Ansiedad el ruido del alma',
    'ES4 - Adoptados por amor',
    'ES5 - Un nuevo comienzo',
    'ES6 - Ahora sé quién soy'
];

function isToday(timestamp) {
    if (!timestamp) return false;
    return new Date().toISOString().slice(0, 10) === new Date(timestamp).toISOString().slice(0, 10);
}

app.get('/', async (req, res) => {
    if (req.query.secret !== CRON_SECRET) return res.sendStatus(403);

    const { data: users } = await supabase.from('usuarios_campana').select('*').eq('estado', 'activo_serie');

    for (const user of users || []) {
        if (!user.telefono || isToday(user.ultimo_envio)) continue;

        // Índice correcto: 0 a 17
        const idx = Math.min((Number(user.capitulo_actual) || 1) - 1, CHAPTERS.length - 1);

        await fetch(`https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: user.telefono, type: 'text', text: { body: CHAPTERS[idx] } })
        });

        await supabase.from('usuarios_campana')
            .update({ ultimo_envio: new Date().toISOString(), capitulo_actual: (Number(user.capitulo_actual) || 1) + 1 })
            .eq('id', user.id);
    }
    return res.status(200).send('Cron ejecutado');
});

module.exports = app;