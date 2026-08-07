const express = require('express');
const crypto = require('crypto');
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

// GET: Validación inicial del Webhook por parte de Meta (Escucha raíz y /webhook)
app.get(['/', '/webhook'], (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook validado exitosamente por Meta.');
            return res.status(200).send(challenge);
        }
        console.warn('Fallo de validación: El token de verificación no coincide.');
        return res.sendStatus(403);
    }

    return res.sendStatus(400);
});

// POST: Recepción de mensajes y eventos (Escucha raíz y /webhook)
app.post(['/', '/webhook'], async (req, res) => {
    try {
        if (!verifyMetaSignature(req)) {
            console.warn('Firma de Meta inválida o META_APP_SECRET no configurado.');
            return res.sendStatus(403);
        }

        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const message = value?.messages?.[0];

            // Filtro de estado: Descartar confirmaciones de lectura/entrega sin romper el servidor
            if (!message) {
                console.log('Evento recibido sin mensajes de texto (actualización de estado).');
                return res.status(200).send('EVENT_RECEIVED');
            }

            const recipientPhoneId = value.metadata?.phone_number_id;
            const senderPhone = message.from;
            const messageText = message.text?.body;

            console.log(`Mensaje entrante de ${senderPhone}: "${messageText}"`);

            const whatsappPhoneNumberId = WHATSAPP_PHONE_NUMBER_ID || recipientPhoneId;

            if (!WHATSAPP_TOKEN || !whatsappPhoneNumberId) {
                console.error('ERROR CRÍTICO: Variables de entorno (Token o ID) faltantes en Vercel.');
                return res.status(200).send('EVENT_RECEIVED_CONFIG_ERROR');
            }

            if (messageText && senderPhone) {
                const responsePayload = {
                    messaging_product: 'whatsapp',
                    to: senderPhone,
                    type: 'text',
                    text: { body: `Misiones Nacionales - Recibido: "${messageText}"` }
                };

                // Bloqueo síncrono: Vercel debe esperar a que Meta reciba la respuesta
                try {
                    await enviarRespuestaTexto(whatsappPhoneNumberId, responsePayload);
                } catch (fetchError) {
                    console.error('Fallo de red al intentar enviar el mensaje a Meta:', fetchError.message);
                    return res.status(200).send('EVENT_RECEIVED_BUT_FETCH_FAILED');
                }
            }

            // Confirmación de éxito a Meta solo cuando nuestro proceso terminó
            return res.status(200).send('EVENT_RECEIVED');
        }

        return res.sendStatus(404);
    } catch (error) {
        console.error('Excepción crítica capturada en el Webhook POST:', error);
        return res.status(200).send('EVENT_RECEIVED_WITH_ERRORS');
    }
});

// Función de envío forzada a usar v26.0
async function enviarRespuestaTexto(phoneNumberId, responsePayload) {
    const url = `https://graph.facebook.com/v26.0/${phoneNumberId}/messages`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(responsePayload),
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`HTTP ${response.status} - ${errorData}`);
    }

    console.log('Respuesta entregada exitosamente a la API de Meta.');
}

module.exports = app;