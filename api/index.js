const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json()); // Esto formatea el body del POST automáticamente

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// GET: Validación estricta según la documentación de Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        // Express maneja el envío como texto/número sin corromperlo
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// POST: Recepción de mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        // CORRECCIÓN 1 (Filtro silencioso): Imprimir absolutamente todo lo que entra antes de filtrarlo.
        console.log('--- NUEVO EVENTO POST DE META ---');
        console.log(JSON.stringify(body, null, 2));

        if (body.object !== 'whatsapp_business_account') {
            return res.sendStatus(404);
        }

        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) {
            // CORRECCIÓN 1: Registrar si el evento fue bloqueado por no ser un mensaje (ej. confirmaciones de lectura).
            console.log('Ignorado: El payload no contiene un mensaje. Puede ser un cambio de estado de entrega.');
            return res.sendStatus(200);
        }

        const senderPhone = message.from;
        const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || body.entry[0].changes[0].value.metadata?.phone_number_id;
        const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
        const graphUrl = `https://graph.facebook.com/v26.0/${whatsappPhoneNumberId}/messages`;

        const { data: user, error } = await supabase
            .from('usuarios_campana')
            .select('*')
            .eq('telefono', senderPhone)
            .maybeSingle();

        // Variable para almacenar el formato del mensaje que le vamos a devolver a Meta
        let payloadMeta;

        if (error || !user) {
            payloadMeta = {
                messaging_product: 'whatsapp',
                to: senderPhone,
                type: 'text',
                text: { body: 'No se encontró tu registro en la campaña.' }
            };
        } else {
            const actionId = message.interactive?.button_reply?.id;
            
            if (actionId === 'ATENCION_PASTOR') {
                await supabase.from('usuarios_campana').update({
                    estado: 'esperando_pastor',
                    solicitud_pastor_at: new Date().toISOString()
                }).eq('id', user.id);

                payloadMeta = {
                    messaging_product: 'whatsapp',
                    to: senderPhone,
                    type: 'text',
                    text: { body: 'Hemos registrado tu solicitud de atención personal. Un pastor del distrito te contactará pronto.' }
                };
            } else {
                payloadMeta = {
                    messaging_product: 'whatsapp',
                    type: 'interactive',
                    to: senderPhone,
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
        }

        // CORRECCIÓN 2 (El engaño del fetch): Enviar a Meta y obligar a Node a leer la respuesta y el código de error.
        console.log('Intentando enviar respuesta a Meta con payload:', JSON.stringify(payloadMeta));
        
        const metaResponse = await fetch(graphUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payloadMeta)
        });

        const metaResponseText = await metaResponse.text();
        
        // Si Meta rechaza el mensaje (ej. token inválido, error en los botones, etc.), lo imprime en rojo.
        if (!metaResponse.ok) {
            console.error(`ERROR DE META (${metaResponse.status}):`, metaResponseText);
        } else {
            console.log('Mensaje enviado exitosamente. Respuesta de Meta:', metaResponseText);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Error crítico procesando webhook POST:', err);
        res.sendStatus(500);
    }
});

module.exports = app;