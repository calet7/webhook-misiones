const express = require('express');
const app = express();
app.use(express.json());

// Token de seguridad que configuraremos en Vercel y Meta
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'misiones_token_seguro_2026';

// 1. ENDPOINT GET: Validación inicial de Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook validado por Meta.');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// 2. ENDPOINT POST: Recepción de tráfico (Mensajes)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        try {
            // Extracción segura de la carga de datos
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const message = value?.messages?.[0];

            if (message) {
                console.log(`Mensaje recibido de ${message.from}: ${message.text?.body}`);
                
                // Aquí va la ejecución de tu lógica de respuesta
                await procesarMensaje(message);
            }
            
            // Regla de latencia: Confirmar recepción a Meta
            res.status(200).send('EVENT_RECEIVED');

        } catch (error) {
            console.error('Falla en el parseo del payload:', error);
            // Si el código falla, devolvemos 200 de todos modos para que Meta no desactive el Webhook. 
            // El try/catch evita que el proceso haga crash.
            res.status(200).send('EVENT_RECEIVED_WITH_ERRORS');
        }
    } else {
        res.sendStatus(404);
    }
});

async function procesarMensaje(message) {
    // Lógica futura de conexión con la API de WhatsApp para enviar el texto de vuelta.
    console.log("Procesando estructura de respuesta...");
}

// Exportación obligatoria para el motor Serverless de Vercel
module.exports = app;