const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase;
function getSupabaseClient() {
    if (!supabase) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });
    }
    return supabase;
}

function buildTriageMenu() {
    return {
        messaging_product: 'whatsapp',
        type: 'interactive',
        interactive: {
            type: 'button',
            body: {
                text: 'Selecciona una opción para continuar con la campaña:'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'ATENCION_PASTOR',
                            title: 'Atención personal de un pastor'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'DUDAS_CAPITULO',
                            title: 'Dudas sobre el Capítulo'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'DIRECCIONES_HORARIOS',
                            title: 'Direcciones y Horarios'
                        }
                    }
                ]
            }
        }
    };
}

async function sendWhatsAppMessage(phoneNumberId, payload) {
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

async function handleTriageAction(user, actionId, senderPhone, whatsappPhoneNumberId) {
    const client = getSupabaseClient();
    const normalizedAction = String(actionId || '').toUpperCase();

    switch (normalizedAction) {
        case 'ATENCION_PASTOR': {
            await client.from('usuarios_campana').update({
                estado: 'esperando_pastor',
                solicitud_pastor_at: new Date().toISOString()
            }).eq('id', user.id);

            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Hemos registrado tu solicitud de atención personal. Un pastor del distrito te contactará pronto.'
                }
            });
            break;
        }
        case 'DUDAS_CAPITULO': {
            await client.from('usuarios_campana').update({
                estado: 'dudas_capitulo'
            }).eq('id', user.id);

            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Tu duda ha sido registrada y será atendida por el equipo pastoral.'
                }
            });
            break;
        }
        case 'DIRECCIONES_HORARIOS': {
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Direcciones y horarios: Visítanos en la iglesia local todos los domingos a las 10:00 AM.'
                }
            });
            break;
        }
        default: {
            await sendWhatsAppMessage(whatsappPhoneNumberId, buildTriageMenu());
            break;
        }
    }
}

function verifyMetaSignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!META_APP_SECRET || !signature || !req.rawBody) {
        return false;
    }

    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', META_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'utf8'),
            Buffer.from(expectedSignature, 'utf8')
        );
    } catch (error) {
        return false;
    }
}

const handleGet = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.sendStatus(403);
    }

    return res.sendStatus(400);
};

const handlePost = async (req, res) => {
    try {
        if (!verifyMetaSignature(req)) {
            return res.sendStatus(403);
        }

        const body = req.body;
        if (body.object !== 'whatsapp_business_account') {
            return res.sendStatus(404);
        }

        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (!message) {
            return res.status(200).send('EVENT_RECEIVED');
        }

        const senderPhone = message.from;
        const whatsappPhoneNumberId = WHATSAPP_PHONE_NUMBER_ID || value.metadata?.phone_number_id;

        const client = getSupabaseClient();
        const { data: user, error } = await client
            .from('usuarios_campana')
            .select('*')
            .eq('telefono', senderPhone)
            .maybeSingle();

        if (error || !user) {
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'No se encontró tu registro en la campaña.'
                }
            });
            return res.status(200).send('EVENT_RECEIVED');
        }

        const actionId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        if (actionId) {
            await handleTriageAction(user, actionId, senderPhone, whatsappPhoneNumberId);
        } else {
            await sendWhatsAppMessage(whatsappPhoneNumberId, buildTriageMenu());
        }

        return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        console.error('Error procesando webhook:', error);
        return res.status(200).send('EVENT_RECEIVED');
    }
};

app.get('/', handleGet);
app.post('/', handlePost);

module.exports = app;