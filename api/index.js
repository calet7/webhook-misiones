const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const verifyMetaSignature = (req, res, next) => {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        console.error("Firma de Meta ausente.");
        return res.sendStatus(401);
    }

    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');

    if (signature !== expectedSignature) {
        console.error("Firma de Meta inválida. Intento de falsificación detectado.");
        return res.sendStatus(401);
    }
    next();
};

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', verifyMetaSignature, async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return res.sendStatus(200);

        const messageId = message.id;
        const senderPhone = message.from;
        const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || body.entry[0].changes[0].value.metadata?.phone_number_id;
        const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
        const graphUrl = `https://graph.facebook.com/v20.0/${whatsappPhoneNumberId}/messages`;

        const { error: idempError } = await supabase.from('registro_webhooks_procesados').insert({ wamid: messageId });
        if (idempError) return res.sendStatus(200);

        const textBody = message.text?.body?.trim() || '';
        const txtLower = textBody.toLowerCase();
        
        let buttonPayload = message.button?.payload || message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
        let payloadsToSend = [];

        const { data: pastor } = await supabase.from('pastores').select('*').eq('telefono', senderPhone).maybeSingle();

        if (pastor) {
            if (txtLower.startsWith('status')) {
                const userPhone = textBody.replace(/\D/g, ''); 
                if (userPhone && userPhone.length >= 10) {
                    payloadsToSend.push({
                        messaging_product: 'whatsapp',
                        to: senderPhone,
                        type: 'interactive',
                        interactive: {
                            type: 'list',
                            header: { type: 'text', text: 'Gestión Pastoral' },
                            body: { text: `Selecciona el nuevo estado para el usuario ${userPhone}:` },
                            footer: { text: 'Campañas IPUC' },
                            action: {
                                button: 'Ver Estados',
                                sections: [{
                                    title: 'Opciones de Estado',
                                    rows: [
                                        { id: `STATUS_4_${userPhone}`, title: 'En Consejería' },
                                        { id: `STATUS_5_${userPhone}`, title: 'Remitido a Congreg.' },
                                        { id: `STATUS_6_${userPhone}`, title: 'Caso Cerrado' },
                                        { id: `STATUS_7_${userPhone}`, title: 'No Contacto Efectivo' }
                                    ]
                                }]
                            }
                        }
                    });
                } else {
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: `⚠️ Formato incorrecto. Escribe: *status numerocelular*` } });
                }
            } 
            else if (buttonPayload.startsWith('STATUS_')) {
                const parts = buttonPayload.split('_');
                const nuevoStatusId = parseInt(parts[1]); 
                const targetPhone = parts[2];

                await supabase.from('usuarios').update({ status_id: nuevoStatusId }).eq('telefono', targetPhone);
                
                const { data: usr } = await supabase.from('usuarios').select('id').eq('telefono', targetPhone).maybeSingle();
                if (usr) {
                    await supabase.from('asignaciones_pastorales')
                        .update({ ultimo_status_reportado: nuevoStatusId })
                        .eq('usuario_id', usr.id)
                        .eq('pastor_id', pastor.id);
                }

                payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: `✅ Estado del usuario ${targetPhone} actualizado correctamente.` } });
            }
        } 
        else {
            const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', senderPhone).maybeSingle();

            if (!user) {
                if (txtLower.includes('quiero iniciar la serie encuentra sentido')) {
                    let nombreUsuario = 'Amigo(a)';
                    let departamentoUsuario = 'No especificado';

                    if (textBody.includes('Mi nombre es ') && textBody.includes(' y soy del departamento de ')) {
                        try {
                            nombreUsuario = textBody.split('Mi nombre es ')[1].split(' y soy')[0].trim();
                            departamentoUsuario = textBody.split('departamento de ')[1].replace('.', '').trim();
                        } catch (e) {
                            console.error('Error parseando las variables:', e);
                        }
                    }

                    const { error: insertError } = await supabase.from('usuarios').insert({
                        telefono: senderPhone,
                        nombre_completo: nombreUsuario,
                        departamento: departamentoUsuario,
                        status_id: 1, 
                        dia_actual: 0,
                        temporada_actual: 1
                    });

                    if (!insertError) {
                        payloadsToSend.push({
                            messaging_product: 'whatsapp',
                            to: senderPhone,
                            type: 'template',
                            template: {
                                name: 'bienvenida_encuentra_sentido', 
                                language: { code: 'es_CO' },
                                components: [
                                    { 
                                        type: 'body', 
                                        parameters: [
                                            { type: 'text', name: 'nombre', text: nombreUsuario }
                                        ] 
                                    }
                                ]
                            }
                        });
                    } else {
                        console.error('Fallo al registrar usuario:', insertError);
                    }
                }
            }
            else {
                if (buttonPayload === 'INICIAR' && user.status_id === 1) {
                    await supabase.from('usuarios').update({ status_id: 2, dia_actual: 1 }).eq('telefono', senderPhone);
                    
                    const { data: episodio1 } = await supabase.from('mensajes_serie').select('*').eq('temporada', 1).eq('dia', 1).maybeSingle();
                    
                    if (episodio1) {
                        payloadsToSend.push({
                            messaging_product: 'whatsapp',
                            to: senderPhone,
                            type: 'template',
                            template: {
                                name: 'envio_diario_encuentra_sentido',
                                language: { code: 'es_CO' },
                                components: [
                                    { 
                                        type: 'header', 
                                        parameters: [
                                            { type: 'image', image: { link: episodio1.url_imagen_versiculo } }
                                        ] 
                                    },
                                    { 
                                        type: 'body', 
                                        parameters: [
                                            { type: 'text', name: 'nombre', text: user.nombre_completo },
                                            { type: 'text', name: 'tema', text: episodio1.nombre_episodio } 
                                        ]
                                    }
                                ]
                            }
                        });
                    }
                }
                else if (buttonPayload === 'ESCUCHAR') {
                    const dia = user.dia_actual === 0 ? 1 : user.dia_actual;
                    const temp = user.temporada_actual || 1;

                    const { data: dataEpisodio } = await supabase.from('mensajes_serie').select('*').eq('temporada', temp).eq('dia', dia).maybeSingle();

                    if (dataEpisodio) {
                        payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'audio', audio: { link: dataEpisodio.url_audio_episodio } });
                        
                        payloadsToSend.push({ 
                            messaging_product: 'whatsapp', 
                            to: senderPhone, 
                            type: 'text', 
                            text: { body: dataEpisodio.texto_versiculo + '\n\n' + dataEpisodio.texto_oracion_personal } 
                        });

                        if (dia === 6) {
                            await supabase.from('usuarios').update({ status_id: 9 }).eq('telefono', senderPhone);

                            let botonesAccion = [];
                            let textoMenu = '';

                            if (temp < 3) {
                                textoMenu = 'Has finalizado esta temporada. ¿Qué deseas hacer para continuar tu proceso?';
                                botonesAccion = [
                                    { type: 'reply', reply: { id: 'SIGUIENTE_TEMPORADA', title: 'Siguiente Temporada' } },
                                    { type: 'reply', reply: { id: 'SPOTIFY', title: 'Escuchar Spotify' } },
                                    { type: 'reply', reply: { id: 'CANAL', title: 'Cápsula de Vida' } }
                                ];
                            } else {
                                textoMenu = 'Has completado todas las temporadas. El camino no termina aquí, ¿qué deseas hacer?';
                                botonesAccion = [
                                    { type: 'reply', reply: { id: 'SPOTIFY', title: 'Escuchar Spotify' } },
                                    { type: 'reply', reply: { id: 'CANAL', title: 'Cápsula de Vida' } }
                                ];
                            }

                            payloadsToSend.push({
                                messaging_product: 'whatsapp',
                                to: senderPhone,
                                type: 'interactive',
                                interactive: {
                                    type: 'button',
                                    body: { text: textoMenu },
                                    action: { buttons: botonesAccion }
                                }
                            });
                        }
                    }
                }
                else if (buttonPayload === 'SIGUIENTE_TEMPORADA') {
                    await supabase.from('usuarios').update({ 
                        temporada_actual: user.temporada_actual + 1, 
                        dia_actual: 0,
                        status_id: 2 
                    }).eq('telefono', senderPhone);
                    
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: '¡Excelente decisión! Mañana a las 9:00 a.m. recibirás el primer episodio de tu nueva temporada.' } });
                }
                else if (buttonPayload === 'SPOTIFY') {
                    await supabase.from('usuarios').update({ suscrito_spotify: true, status_id: 6 }).eq('telefono', senderPhone); 
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Aquí tienes nuestro Spotify para que escuches todas las reflexiones: [LINK_SPOTIFY]' } });
                }
                else if (buttonPayload === 'CANAL') {
                    await supabase.from('usuarios').update({ status_id: 6 }).eq('telefono', senderPhone);
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Únete a nuestro canal oficial haciendo clic aquí: www.ipucmisionesnacionales.org/canal' } });
                }
                else if (buttonPayload === 'ACOMPANAMIENTO') {
                    const { data: pastores } = await supabase
                        .from('pastores')
                        .select('*')
                        .eq('departamento', user.departamento)
                        .eq('estado_pastor', 'LIBRE')
                        .order('carga_n', { ascending: true })
                        .limit(1);

                    let pastorAsignado = pastores?.[0];

                    if (pastorAsignado) {
                        await supabase.from('usuarios').update({ status_id: 3 }).eq('telefono', senderPhone);
                        
                        await supabase.from('asignaciones_pastorales').insert({
                            usuario_id: user.id,
                            pastor_id: pastorAsignado.id,
                            ultimo_status_reportado: 3 
                        });

                        payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos registrado tu solicitud. Un pastor de tu departamento te contactará pronto.' } });
                        payloadsToSend.push({ messaging_product: 'whatsapp', to: pastorAsignado.telefono, type: 'text', text: { body: `🚨 *NUEVO CASO ASIGNADO*\n\nUsuario: *${user.nombre_completo}*\n📱 ${senderPhone}\n🔗 wa.me/${senderPhone}\n\nPara gestionar este caso, escribe:\n*status ${senderPhone}*` } });
                    } else {
                        await supabase.from('usuarios').update({ status_id: 3 }).eq('telefono', senderPhone);
                        payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos recibido tu solicitud. Nuestro equipo te contactará a la brevedad posible.' } });
                    }
                }
                else if (txtLower === 'amen' || txtLower === 'amén' || txtLower.includes('gracias') || txtLower.includes('bendiciones')) {
                    const respuestas = [
                        '¡Amén! Que Dios te bendiga 🙏',
                        'Gracias a ti por leernos 🌻',
                        'Dios te bendiga grandemente 🙌'
                    ];
                    const respuestaAzar = respuestas[Math.floor(Math.random() * respuestas.length)];
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: respuestaAzar } });
                }
                else if (txtLower.includes('cancelar suscripcion') || txtLower.includes('cancelar suscripción')) {
                    payloadsToSend.push({
                        messaging_product: 'whatsapp',
                        to: senderPhone,
                        type: 'interactive',
                        interactive: {
                            type: 'button',
                            body: { text: '¿Qué deseas hacer respecto a tus datos y suscripción?' },
                            action: {
                                buttons: [
                                    { type: 'reply', reply: { id: 'HABEAS_BORRAR', title: 'Borrar Datos' } },
                                    { type: 'reply', reply: { id: 'HABEAS_INACTIVO', title: 'Dejar de Recibir' } }
                                ]
                            }
                        }
                    });
                }
                else if (buttonPayload === 'HABEAS_BORRAR') {
                    await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'BORRADO_TOTAL' });
                    await supabase.from('usuarios').delete().eq('telefono', senderPhone);
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Tus datos han sido eliminados por completo de nuestras bases de datos.' } });
                }
                else if (buttonPayload === 'HABEAS_INACTIVO') {
                    await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'MARCADO_INACTIVO' });
                    await supabase.from('usuarios').update({ status_id: 8 }).eq('telefono', senderPhone); 
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos pausado los envíos. No recibirás más mensajes de esta serie.' } });
                }
            }
        }

        if (payloadsToSend.length > 0) {
            await Promise.all(payloadsToSend.map(payload => 
                fetch(graphUrl, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(async metaResponse => {
                    if (!metaResponse.ok) {
                        const errText = await metaResponse.text();
                        console.error(`ERROR DE META:`, errText);
                    }
                }).catch(networkError => {
                    console.error(`ERROR FATAL DE RED HACIA META:`, networkError.message);
                })
            ));
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Error crítico en webhook:', err);
        res.sendStatus(500); 
    }
});

module.exports = app;