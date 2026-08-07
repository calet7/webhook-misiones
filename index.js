const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

// Middleware para capturar el rawBody, necesario para verificar la firma de Meta
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
const CRON_SECRET = process.env.CRON_SECRET;

let supabase;
function getSupabaseClient() {
    if (!supabase) {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            throw new Error('SUPABASE_URL y SUPABASE_KEY son requeridos para inicializar Supabase.');
        }
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });
    }
    return supabase;
}

const CHAPTERS = [
    'Capítulo 1: Bienvenido a la campaña. Hoy hablaremos de la visión del proyecto y cómo puedes acompañar cada día.',
    'Capítulo 2: La historia de la misión y la importancia de la comunidad. Aprende a vivir la fe en familia.',
    'Capítulo 3: Compartiendo esperanza a través del servicio y la oración. Encuentra un propósito claro hoy.',
    'Capítulo 4: Cómo mantener el compromiso espiritual y recibir apoyo de tu pastor.',
    'Capítulo 5: El siguiente paso para tu crecimiento espiritual y cómo ser parte activa de la campaña.'
];

function isToday(timestamp) {
    if (!timestamp) return false;
    const now = new Date();
    const date = new Date(timestamp);
    return now.toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
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

function getDailyChapter(user) {
    const chapterNumber = Number(user.capitulo_actual) || 1;
    const index = Math.max(0, Math.min(chapterNumber - 1, CHAPTERS.length - 1));
    return CHAPTERS[index];
}

async function sendWhatsAppMessage(phoneNumberId, payload) {
    if (!WHATSAPP_TOKEN) {
        throw new Error('La variable WHATSAPP_TOKEN no está configurada.');
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

async function findUsuarioByPhone(phone) {
    const client = getSupabaseClient();
    const { data, error } = await client
        .from('usuarios_campana')
        .select('*')
        .eq('telefono', phone)
        .maybeSingle();

    if (error) {
        console.error('Error consultando usuario en Supabase:', error.message);
        throw error;
    }

    return data;
}

async function updateUsuario(userId, updates) {
    const client = getSupabaseClient();
    const { error } = await client
        .from('usuarios_campana')
        .update(updates)
        .eq('id', userId);

    if (error) {
        console.error('Error actualizando usuario en Supabase:', error.message);
        throw error;
    }
}

async function notifyCoordinadores(user, phoneNumberId) {
    const client = getSupabaseClient();
    const { data, error } = await client
        .from('directorio_pastores')
        .select('*')
        .eq('distrito', user.distrito)
        .ilike('rol', '%coordinador%');

    if (error) {
        console.error('Error consultando directorio de pastores:', error.message);
        return;
    }

    const message = `Solicitud de atención personal de ${user.nombre || 'un participante'} (${user.telefono}). Distrito: ${user.distrito}.`;

    for (const coordinator of data || []) {
        if (!coordinator.telefono) {
            continue;
        }

        await sendWhatsAppMessage(phoneNumberId, {
            messaging_product: 'whatsapp',
            to: coordinator.telefono,
            type: 'text',
            text: { body: message }
        });
    }
}

function getIncomingAction(message) {
    const buttonReplyId = message.interactive?.button_reply?.id;
    const listReplyId = message.interactive?.list_reply?.id;
    const textBody = String(message.text?.body || '').trim().toUpperCase();

    if (buttonReplyId) {
        return buttonReplyId;
    }
    if (listReplyId) {
        return listReplyId;
    }
    if (textBody === '1' || textBody.includes('ATENCIÓN') || textBody.includes('PASTOR')) {
        return 'ATENCION_PASTOR';
    }
    if (textBody === '2' || textBody.includes('DUDAS') || textBody.includes('CAPÍTULO')) {
        return 'DUDAS_CAPITULO';
    }
    if (textBody === '3' || textBody.includes('DIRECCIONES') || textBody.includes('HORARIOS')) {
        return 'DIRECCIONES_HORARIOS';
    }

    return null;
}

async function handleTriageAction(user, actionId, senderPhone, whatsappPhoneNumberId) {
    const normalizedAction = String(actionId || '').toUpperCase();

    switch (normalizedAction) {
        case 'ATENCION_PASTOR': {
            await updateUsuario(user.id, {
                estado: 'esperando_pastor',
                solicitud_pastor_at: new Date().toISOString()
            });
            await notifyCoordinadores(user, whatsappPhoneNumberId);
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
        }
        case 'DIRECCIONES_HORARIOS': {
            await sendWhatsAppMessage(whatsappPhoneNumberId, {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: {
                    body: 'Direcciones y horarios: Visítanos en la iglesia local todos los domingos a las 10:00 AM. Para consultas, responde este mensaje.'
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

app.get('/api/webhook', (req, res) => {
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

app.post('/api/webhook', async (req, res) => {
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
            return res.status(200).send('EVENT_RECEIVED_CONFIG_ERROR');
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
        console.error('Error procesando webhook:', error);
        return res.status(200).send('EVENT_RECEIVED_WITH_ERRORS');
    }
});

async function processCronSerie(req, res) {
    if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
        return res.sendStatus(403);
    }

    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        return res.status(500).send('CONFIGURATION_ERROR');
    }

    try {
        const client = getSupabaseClient();
        const { data: users, error } = await client
            .from('usuarios_campana')
            .select('*')
            .eq('estado', 'activo_serie');

        if (error) {
            console.error('Error consultando usuarios activos de la campaña:', error.message);
            return res.status(500).send('SUPABASE_ERROR');
        }

        let sent = 0;
        let skipped = 0;

        for (const user of users || []) {
            if (isToday(user.ultimo_envio)) {
                skipped++;
                continue;
            }

            if (!user.telefono) {
                skipped++;
                continue;
            }

            const chapterText = getDailyChapter(user);
            await sendWhatsAppMessage(WHATSAPP_PHONE_NUMBER_ID, {
                messaging_product: 'whatsapp',
                to: user.telefono,
                type: 'text',
                text: {
                    body: chapterText
                }
            });

            await updateUsuario(user.id, {
                ultimo_envio: new Date().toISOString(),
                capitulo_actual: (Number(user.capitulo_actual) || 1) + 1
            });
            sent++;
        }

        return res.status(200).json({ sent, skipped });
    } catch (error) {
        console.error('Error ejecutando cron de serie:', error);
        return res.status(500).send('CRON_ERROR');
    }
}

app.get('/api/cron-serie', processCronSerie);
app.post('/api/cron-serie', processCronSerie);

module.exports = app;