const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// --- Funciones auxiliares ---
async function sendWhatsAppMessage(payload) {
    const url = `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

async function findUsuarioByPhone(phone) {
    const { data } = await supabase.from('usuarios_campana').select('*').eq('telefono', phone).maybeSingle();
    return data;
}

async function updateUsuario(userId, updates) {
    await supabase.from('usuarios_campana').update(updates).eq('id', userId);
}

// --- Lógica del Webhook ---
function verifyMetaSignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!META_APP_SECRET || !signature || !req.rawBody) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

app.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
});

app.post('/', async (req, res) => {
    if (!verifyMetaSignature(req)) return res.sendStatus(403);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.status(200).send('OK');

    const sender = message.from;
    const user = await findUsuarioByPhone(sender);
    
    if (!user) {
        await sendWhatsAppMessage({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: 'No registrado.' } });
    } else {
        // Lógica de triaje que ya tenías
        await sendWhatsAppMessage({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: 'Menu de opciones...' } });
    }
    return res.status(200).send('OK');
});

module.exports = app;