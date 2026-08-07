const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Variables de entorno
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// --- Lógica de WhatsApp y Supabase ---
async function sendWhatsAppMessage(payload) {
    const url = `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

function buildTriageMenu() {
    return {
        messaging_product: 'whatsapp',
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: '¿En qué podemos ayudarte hoy?' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'ATENCION_PASTOR', title: 'Hablar con Pastor' } },
                    { type: 'reply', reply: { id: 'DUDAS_CAPITULO', title: 'Dudas Capítulo' } },
                    { type: 'reply', reply: { id: 'HORARIOS', title: 'Horarios' } }
                ]
            }
        }
    };
}

async function handleTriageAction(user, actionId, sender) {
    if (actionId === 'ATENCION_PASTOR') {
        await supabase.from('usuarios_campana').update({ estado: 'esperando_pastor' }).eq('id', user.id);
        await sendWhatsAppMessage({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: 'Un pastor te contactará pronto.' } });
    } else {
        await sendWhatsAppMessage({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: 'Opción recibida.' } });
    }
}

// --- Seguridad y Rutas ---
function verifyMetaSignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!META_APP_SECRET || !signature || !req.rawBody) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

const handleGet = (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
};

const handlePost = async (req, res) => {
    if (!verifyMetaSignature(req)) return res.sendStatus(403);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.status(200).send('OK');

    const sender = message.from;
    const { data: user } = await supabase.from('usuarios_campana').select('*').eq('telefono', sender).maybeSingle();
    
    if (!user) {
        await sendWhatsAppMessage({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: 'No registrado.' } });
    } else {
        const action = message.interactive?.button_reply?.id;
        if (action) {
            await handleTriageAction(user, action, sender);
        } else {
            await sendWhatsAppMessage(buildTriageMenu());
        }
    }
    return res.status(200).send('OK');
};

// Rutas explícitas para Vercel
app.get('/', handleGet);
app.post('/', handlePost);
app.get('/api/webhook', handleGet);
app.post('/api/webhook', handlePost);

module.exports = app;