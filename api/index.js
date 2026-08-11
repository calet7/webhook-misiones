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
        
        console.log('📦 RAW MESSAGE OBJECT:', JSON.stringify(message, null, 2));

        let buttonPayload = message.button?.payload || message.button?.text || message.interactive?.button_reply?.id || message.interactive?.button_reply?.title || message.interactive?.list_reply?.id || message.interactive?.list_reply?.title || '';
        buttonPayload = String(buttonPayload).trim().toLowerCase();

        let payloadsToSend = [];

        console.log(`🔎 Evaluando -> Text: "${textBody}", ButtonPayload: "${buttonPayload}"`);

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
            else if (buttonPayload.startsWith('status_')) {
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
            
            console.log(`👤 Búsqueda BD Usuarios -> ${user ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
            if (user) console.log(`📊 Datos BD: Status=${user.status_id}, Día=${user.dia_actual}, Nombre=${user.nombre_completo}`);

            if (!user) {
                if (txtLower.includes('quiero iniciar la serie encuentra sentido')) {
                    console.log('👤 Procesando registro de nuevo usuario...');
                    let nombreUsuario = '';
                    let departamentoUsuario = '';

                    const matchNombre = textBody.match(/mi nombre es\s+(.*?)\s+y soy/i);
                    const matchDepto = textBody.match(/departamento de\s+(.*?)(?:\.|$)/i);

                    if (matchNombre && matchNombre[1]) {
                        nombreUsuario = matchNombre[1].trim();
                    }
                    if (matchDepto && matchDepto[1]) {
                        departamentoUsuario = matchDepto[1].trim();
                    }

                    console.log(`✅ Datos extraídos -> Nombre: ${nombreUsuario}, Depto: ${departamentoUsuario}`);

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
                                            { type: 'text', text: nombreUsuario }
                                        ] 
                                    }
                                ]
                            }
                        });
                    } else {
                        console.error('❌ Fallo al registrar usuario:', insertError);
                    }
                } else {
                    console.log(`⚠️ Registro ignorado: El texto no coincide con la frase obligatoria de registro.`);
                }
            }
            else {
                const esIniciarBtn = buttonPayload.includes('iniciar');
                const esIniciarTxt = txtLower.includes('iniciar');
                const esStatus1 = user.status_id === 1;
                
                console.log(`🚦 Evaluación Condición INICIAR -> BtnIniciar: ${esIniciarBtn}, TxtIniciar: ${esIniciarTxt}, StatusEs1: ${esStatus1}`);

                if ((esIniciarBtn || esIniciarTxt) && esStatus1) {
                    console.log('▶️ CONDICIÓN APROBADA. Avanzando a status 2 y buscando episodio...');
                    await supabase.from('usuarios').update({ status_id: 2, dia_actual: 1 }).eq('telefono', senderPhone);
                    
                    const { data: episodio1, error: epError } = await supabase.from('mensajes_serie').select('*').eq('temporada', 1).eq('dia', 1).maybeSingle();
                    
                    if (epError) console.error('❌ Error DB consultando episodios:', epError);

                    if (episodio1) {
                        console.log(`✅ Episodio preparado: ${episodio1.nombre_episodio} | Imagen: ${episodio1.url_imagen_versiculo}`);

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
                                            { type: 'text', text: user.nombre_completo || 'Usuario' }, 
                                            { type: 'text', text: episodio1.nombre_episodio || 'tu reflexión' } 
                                        ]
                                    }
                                ]
                            }
                        });
                    } else {
                        console.log('⚠️ ALERTA: La base de datos devolvió NULL para el episodio T1 D1.');
                    }
                }
                else if (buttonPayload === 'escuchar') {
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
                                    { type: 'reply', reply: { id: 'siguiente_temporada', title: 'Siguiente Temporada' } },
                                    { type: 'reply', reply: { id: 'spotify', title: 'Escuchar Spotify' } },
                                    { type: 'reply', reply: { id: 'canal', title: 'Cápsula de Vida' } }
                                ];
                            } else {
                                textoMenu = 'Has completado todas las temporadas. El camino no termina aquí, ¿qué deseas hacer?';
                                botonesAccion = [
                                    { type: 'reply', reply: { id: 'spotify', title: 'Escuchar Spotify' } },
                                    { type: 'reply', reply: { id: 'canal', title: 'Cápsula de Vida' } }
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
                else if (buttonPayload === 'siguiente_temporada') {
                    await supabase.from('usuarios').update({ 
                        temporada_actual: user.temporada_actual + 1, 
                        dia_actual: 0,
                        status_id: 2 
                    }).eq('telefono', senderPhone);
                    
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: '¡Excelente decisión! Mañana a las 9:00 a.m. recibirás el primer episodio de tu nueva temporada.' } });
                }
                else if (buttonPayload === 'spotify') {
                    await supabase.from('usuarios').update({ suscrito_spotify: true, status_id: 6 }).eq('telefono', senderPhone); 
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Aquí tienes nuestro Spotify para que escuches todas las reflexiones: [LINK_SPOTIFY]' } });
                }
                else if (buttonPayload === 'canal') {
                    await supabase.from('usuarios').update({ status_id: 6 }).eq('telefono', senderPhone);
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Únete a nuestro canal oficial haciendo clic aquí: www.ipucmisionesnacionales.org/canal' } });
                }
                else if (buttonPayload === 'acompanamiento' || buttonPayload === 'acompañamiento') {
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
                        
                        payloadsToSend.push({
                            messaging_product: 'whatsapp',
                            to: pastorAsignado.telefono,
                            type: 'template',
                            template: {
                                name: 'alerta_nuevo_caso',
                                language: { code: 'es_CO' },
                                components: [
                                    {
                                        type: 'body',
                                        parameters: [
                                            { type: 'text', text: pastorAsignado.nombre },
                                            { type: 'text', text: user.nombre_completo },
                                            { type: 'text', text: `wa.me/${senderPhone}` }
                                        ]
                                    }
                                ]
                            }
                        });
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
                                    { type: 'reply', reply: { id: 'habeas_borrar', title: 'Borrar Datos' } },
                                    { type: 'reply', reply: { id: 'habeas_inactivo', title: 'Dejar de Recibir' } }
                                ]
                            }
                        }
                    });
                }
                else if (buttonPayload === 'habeas_borrar') {
                    await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'BORRADO_TOTAL' });
                    await supabase.from('usuarios').delete().eq('telefono', senderPhone);
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Tus datos han sido eliminados por completo de nuestras bases de datos.' } });
                }
                else if (buttonPayload === 'habeas_inactivo') {
                    await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'MARCADO_INACTIVO' });
                    await supabase.from('usuarios').update({ status_id: 8 }).eq('telefono', senderPhone); 
                    payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos pausado los envíos. No recibirás más mensajes de esta serie.' } });
                } else {
                    console.log(`⚠️ Ninguna acción programada para el payload: "${buttonPayload}"`);
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
                    } else {
                        console.log('✅ Mensaje despachado con éxito a Meta.');
                    }
                }).catch(networkError => {
                    console.error(`ERROR FATAL DE RED HACIA META:`, networkError.message);
                })
            ));
        } else {
            console.log('ℹ️ No hay payloads preparados para enviar.');
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Error crítico en webhook:', err);
        res.sendStatus(500); 
    }
});

module.exports = app;