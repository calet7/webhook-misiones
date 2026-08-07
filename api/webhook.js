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

function getSupabaseClient() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('SUPABASE_URL y SUPABASE_KEY son necesarios.');
    }
    return createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false }
    });
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

function getIncomingAction(message) {
    const buttonReplyId = message.interactive?.button_reply?.id;
    const listReplyId = message.interactive?.list_reply?.id;
    const textBody = String(message.text?.body || '').trim().toUpperCase();

    if (buttonReplyId) return buttonReplyId;
    if (listReplyId) return listReplyId;
    if (textBody === '1' || textBody.includes('ATENCIÓN') || textBody.includes('PASTOR')) return 'ATENCION_PASTOR';
    if (textBody === '2' || textBody.includes('DUDAS') || textBody.includes('CAPÍTULO')) return 'DUDAS_CAPITULO';
    if (textBody === '3' || textBody.includes('DIRECCIONES') || textBody.includes('HORARIOS')) return 'DIRECCIONES_HORARIOS';

    return null;
}

async function findUsuarioByPhone(phone) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
        .from('usuarios_campana')
        .select('*')
        .eq('telefono', phone)
        .maybeSingle();

    if (error) {
        console.error('Supabase error findUsuarioByPhone:', error.message);
        throw error;
    }
    return data;
}

async function findDistritoByUsuario(user) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
        .from('distritos')
        .select('*')
        .eq('id', user.distrito)
        .maybeSingle();

    if (error) {
        console.error('Supabase error findDistritoByUsuario:', error.message);
        throw error;
    }
    return data;
}

async function notifyCoordinadores(user, phoneNumberId) {
    const supabase = getSupabaseClient();
    const distritoRecord = await findDistritoByUsuario(user);
    const userDistrito = user.distrito || distritoRecord?.id;
    if (!userDistrito) {
        console.error('No se encontró distrito para el usuario.');
        return;
    }

    const { data, error } = await supabase
        .from('directorio_pastores')
        .select('*')
        .eq('distrito', userDistrito)
        .ilike('rol', '%coordinador%');

    if (error) {
        console.error('Supabase error notifyCoordinadores:', error.message);
        return;
    }

    const message = `Solicitud de atención personal de ${user.nombre || 'participante'} (${user.telefono}). Distrito: ${userDistrito}.`;
    for (const coordinator of data || []) {
        if (!coordinator.telefono) continue;
        await sendWhatsAppMessage(phoneNumberId, {
            messaging_product: 'whatsapp',
            to: coordinator.telefono,
            type: 'text',
            text: { body: message }
        });
    }
}

async function handleTriageAction(user, actionId, senderPhone, whatsappPhoneNumberId) {
    const normalizedAction = String(actionId || '').toUpperCase();

    switch (normalizedAction) {
        case 'ATENCION_PASTOR':
            await updateUsuario(user.id, {
                estado: 'esperando_pastor',
                solicitud_pastor_at: new Date().toISOString()
            });
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Hemos registrado tu solicitud de atención personal. Un pastor del distrito te contactará pronto.'
                }
            });
            await notifyCoordinadores(user, whatsappPhoneNumberId);
            break;
        case 'DUDAS_CAPITULO':
            await updateUsuario(user.id, {
                estado: 'dudas_capitulo'
            });
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Tu duda ha sido registrada y será atendida por el equipo pastoral. Gracias por participar en la campaña.'
                }
            });
            break;
        case 'DIRECCIONES_HORARIOS':
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Direcciones y horarios: Visítanos en la iglesia local todos los domingos a las 10:00 AM. Para consultas, responde este mensaje.'
                }
            });
            break;
        default:
            await sendWhatsAppMessage(whatsappPhoneNumberId, buildTriageMenu());
            break;
    }
}

app.get('/', (req, res) => {
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
});

app.post('/', async (req, res) => {
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
        if (!WHATSAPP_TOKEN || !whatsappPhoneNumberId) {
            return res.status(500).send('CONFIGURATION_ERROR');
        }

        const user = await findUsuarioByPhone(senderPhone);
        if (!user) {
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'No se encontró tu registro en la campaña. Por favor registra tu número para continuar.'
                }
            });
            return res.status(200).send('EVENT_RECEIVED');
        }

        const actionId = getIncomingAction(message);
        if (actionId) {
            await handleTriageAction(user, actionId, senderPhone, whatsappPhoneNumberId);
            return res.status(200).send('EVENT_RECEIVED');
        }

        await sendWhatsAppMessage(whatsappPhoneNumberId, buildTriageMenu());
        return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        console.error('webhook error:', error);
        return res.status(500).send('SERVER_ERROR');
    }
});

module.exports = app;
