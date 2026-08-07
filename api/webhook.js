const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

module.exports = async function handler(req, res) {
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            res.setHeader('Content-Type', 'text/plain');
            return res.status(200).send(challenge);
        }
        return res.status(403).send('Forbidden');
    }

    if (req.method === 'POST') {
        try {
            const body = req.body;
            if (body.object !== 'whatsapp_business_account') {
                return res.status(404).send('Not Found');
            }

            const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
            if (!message) {
                return res.status(200).send('EVENT_RECEIVED');
            }

            const senderPhone = message.from;
            const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || body.entry[0].changes[0].value.metadata?.phone_number_id;
            const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

            const { data: user, error } = await supabase
                .from('usuarios_campana')
                .select('*')
                .eq('telefono', senderPhone)
                .maybeSingle();

            const graphUrl = `https://graph.facebook.com/v26.0/${whatsappPhoneNumberId}/messages`;

            if (error || !user) {
                await fetch(graphUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: senderPhone,
                        type: 'text',
                        text: { body: 'No se encontró tu registro en la campaña.' }
                    })
                });
            } else {
                const actionId = message.interactive?.button_reply?.id;
                if (actionId === 'ATENCION_PASTOR') {
                    await supabase.from('usuarios_campana').update({
                        estado: 'esperando_pastor',
                        solicitud_pastor_at: new Date().toISOString()
                    }).eq('id', user.id);

                    await fetch(graphUrl, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            messaging_product: 'whatsapp',
                            to: senderPhone,
                            type: 'text',
                            text: { body: 'Hemos registrado tu solicitud de atención personal. Un pastor del distrito te contactará pronto.' }
                        })
                    });
                } else {
                    await fetch(graphUrl, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
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
                        })
                    });
                }
            }

            return res.status(200).send('EVENT_RECEIVED');
        } catch (err) {
            console.error('Error procesando webhook POST:', err);
            return res.status(200).send('EVENT_RECEIVED');
        }
    }

    return res.status(405).send('Method Not Allowed');
};