const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
// Usar fetch global de Node 18+ (Vercel ya lo expone)
const fetch = globalThis.fetch;

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false }
});

/**
 * TEMPLATE_MAP CORREGIDO (FIX: header en cierre_encuentra_sentido y language ajustado)
 */
const TEMPLATE_MAP = {
  bienvenida_encuentra_sentido: {
    mode: 'named',
    language: 'es_CO',
    components: [
      { type: 'body', placeholders: ['nombre'] }
    ]
  },
  envio_diario_encuentra_sentido: {
    mode: 'named',
    language: 'es_CO',
    components: [
      { type: 'header', placeholders: ['imagen_header'] },
      { type: 'body', placeholders: ['nombre', 'tema'] }
    ]
  },
  alerta_nuevo_caso: {
    mode: 'named',
    language: 'es_CO',
    components: [
      { type: 'body', placeholders: ['nombre_pastor', 'nombre', 'enlace_whatsapp'] }
    ]
  },
  cierre_encuentra_sentido: {
    mode: 'named',
    language: 'es', // FIX: según tu nota esta plantilla está en "Spanish"
    components: [
      { type: 'header', placeholders: ['imagen_header'] }, // FIX: faltaba el header
      { type: 'body', placeholders: ['nombre'] }
    ]
  }
};

function buildTemplatePayload(to, templateName, values) {
  const meta = TEMPLATE_MAP[templateName];
  if (!meta) throw new Error(`Template ${templateName} no registrado en TEMPLATE_MAP`);

  const isArray = Array.isArray(values);
  if (meta.mode === 'named' && isArray) {
    throw new Error(`Template ${templateName} espera placeholders nombrados, no posicionales`);
  }

  const valuesObj = isArray ? null : (values || {});
  const valuesArr = isArray ? [...values] : null;

  const components = meta.components.map(comp => {
    const params = comp.placeholders.map(ph => {
      let val;
      if (meta.mode === 'named') {
        val = valuesObj[ph];
        if (val === undefined || val === null || String(val).trim() === '') {
          throw new Error(`Falta valor para placeholder nombrado "${ph}" en plantilla ${templateName}`);
        }
      } else {
        val = valuesArr.shift();
        if (val === undefined || val === null) {
          throw new Error(`Falta valor posicional para plantilla ${templateName}`);
        }
      }

      // header image detection por nombre de placeholder
      if (comp.type === 'header' && ph.toLowerCase().includes('imagen')) {
        if (!/^https?:\/\//i.test(String(val))) {
          throw new Error(`El placeholder "${ph}" para header imagen debe ser una URL válida`);
        }
        // Meta espera { type: 'image', image: { link: '...' } }
        return { type: 'image', image: { link: String(val) } };
      }

      // default: text parameter (sin "name")
      return { type: 'text', text: String(val) };
    });

    return { type: comp.type, parameters: params };
  });

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: meta.language },
      components
    }
  };
}

/**
 * Sanitizador: elimina claves no permitidas (ej. name) y normaliza parámetros
 */
function sanitizeTemplateForMeta(payload) {
  try {
    if (!payload || !payload.template || !Array.isArray(payload.template.components)) return payload;
    const copy = JSON.parse(JSON.stringify(payload)); // deep clone
    for (const comp of copy.template.components) {
      if (!Array.isArray(comp.parameters)) continue;
      comp.parameters = comp.parameters.map(param => {
        if (param == null) return param;
        // image
        if (param.type === 'image' && param.image && param.image.link) {
          return { type: 'image', image: { link: String(param.image.link) } };
        }
        // text
        if (param.type === 'text' && (param.text !== undefined && param.text !== null)) {
          return { type: 'text', text: String(param.text) };
        }
        // fallback: keep only allowed keys
        const out = {};
        if (param.type) out.type = param.type;
        if (param.text) out.text = String(param.text);
        if (param.image && param.image.link) out.image = { link: String(param.image.link) };
        return out;
      });
    }
    return copy;
  } catch (e) {
    console.error('sanitizeTemplateForMeta error:', e?.message || e);
    return payload;
  }
}

/**
 * Inyectar parámetros de botón si faltan (fallback seguro)
 * - Si TEMPLATE_MAP declara un componente 'button' pero el payload no lo tiene, inyecta un parámetro por defecto.
 */
function ensureButtonParams(meta, payload, senderPhone) {
  try {
    if (!meta || !Array.isArray(meta.components)) return payload;
    const copy = JSON.parse(JSON.stringify(payload));
    for (const compMeta of meta.components) {
      if (compMeta.type === 'button') {
        // buscar componente button en payload
        let comp = copy.template.components.find(c => c.type === 'button');
        if (!comp || !Array.isArray(comp.parameters) || comp.parameters.length === 0) {
          const fallback = { type: 'text', text: `https://wa.me/${senderPhone}` };
          if (!comp) {
            copy.template.components.push({ type: 'button', parameters: [fallback] });
          } else {
            comp.parameters = [fallback];
          }
        }
      }
    }
    return copy;
  } catch (e) {
    console.error('ensureButtonParams error:', e?.message || e);
    return payload;
  }
}

/**
 * recordRejectedPayload
 */
async function recordRejectedPayload(supabaseClient, payloadRecord) {
  try {
    await supabaseClient.from('payloads_rechazados').insert(payloadRecord);
    return true;
  } catch (dbErr) {
    console.error('No se pudo guardar payload rechazado en DB:', dbErr?.message || dbErr);
    try {
      console.error('BACKUP PAYLOAD:', JSON.stringify(payloadRecord));
    } catch (logErr) {
      console.error('Fallo al guardar backup del payload:', logErr?.message || logErr);
    }
    return false;
  }
}

/**
 * safeBuildTemplatePush (intenta named; si falla, intenta convertir a posicional)
 */
async function safeBuildTemplatePush(targetArray, to, templateName, values, context = {}, opts = { fallbackText: true }) {
  // Helper: construir payload posicional a partir de values nombrados y TEMPLATE_MAP
  function buildPositionalFromNamed(templateName, namedValues) {
    const meta = TEMPLATE_MAP[templateName];
    if (!meta) throw new Error(`Template ${templateName} no registrado en TEMPLATE_MAP`);
    const arr = [];
    for (const comp of meta.components) {
      for (const ph of comp.placeholders) {
        const v = namedValues[ph];
        if (v === undefined || v === null || String(v).trim() === '') {
          throw new Error(`Falta valor para placeholder "${ph}" al convertir a posicional`);
        }
        arr.push(v);
      }
    }
    return arr;
  }

  try {
    // Intento 1: construir con la lógica normal (named o posicional según TEMPLATE_MAP)
    const tpl = buildTemplatePayload(to, templateName, values);
    targetArray.push(tpl);
    console.log(`safeBuildTemplatePush: payload construido con modo declarado para plantilla ${templateName}`);
    return true;
  } catch (err) {
    console.error(`Error buildTemplatePayload ${templateName}:`, err.message, 'context:', context);

    // Intentar fallback posicional si corresponde
    try {
      const meta = TEMPLATE_MAP[templateName];
      const isNamedMode = meta && meta.mode === 'named';
      const valuesIsObject = values && !Array.isArray(values) && typeof values === 'object';

      if (isNamedMode && valuesIsObject) {
        const positional = buildPositionalFromNamed(templateName, values);
        const tplPos = buildTemplatePayload(to, templateName, positional);
        targetArray.push(tplPos);
        console.log(`safeBuildTemplatePush: fallback posicional aplicado para plantilla ${templateName}`);
        return true;
      }
    } catch (fallbackErr) {
      console.error(`Fallback posicional falló para ${templateName}:`, fallbackErr.message);
      // continuar al registro del payload rechazado
    }

    // Guardar para análisis sin bloquear el webhook
    const record = {
      template_name: templateName,
      values: values || null,
      error_message: err.message,
      context: context || null,
      created_at: new Date().toISOString()
    };

    await recordRejectedPayload(supabase, record);

    // Fallback: enviar un texto simple para confirmar recepción y evitar reintentos de Meta
    if (opts.fallbackText) {
      try {
        const fallback = {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: 'Recibimos tu mensaje y estamos procesándolo. Te contactaremos pronto.' }
        };
        targetArray.push(fallback);
      } catch (fallbackErr) {
        console.error('Error creando fallback text payload:', fallbackErr?.message || fallbackErr);
      }
    }

    return false;
  }
}

/**
 * Verificación de firma de Meta (X-Hub-Signature-256)
 */
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

    const graphUrl = `https://graph.facebook.com/v26.0/${whatsappPhoneNumberId}/messages`;

    // Idempotencia: registrar wamid procesado
    const { error: idempError } = await supabase.from('registro_webhooks_procesados').insert({ wamid: messageId });
    if (idempError) {
      console.warn('Idempotencia: no se procesará mensaje duplicado o hubo error al insertar registro:', idempError);
      return res.sendStatus(200);
    }

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
      } else if (buttonPayload.startsWith('status_')) {
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
    } else {
      const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', senderPhone).maybeSingle();

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
            await safeBuildTemplatePush(
              payloadsToSend,
              senderPhone,
              'bienvenida_encuentra_sentido',
              { nombre: nombreUsuario },
              { wamid: messageId, step: 'registro_usuario', telefono: senderPhone },
              { fallbackText: true }
            );
          } else {
            console.error('Fallo al registrar usuario:', insertError);
          }
        }
      } else {
        if ((buttonPayload.includes('iniciar') || txtLower.includes('iniciar')) && user.status_id === 1) {
          console.log('▶️ Comando INICIAR detectado. Avanzando a status 2...');
          await supabase.from('usuarios').update({ status_id: 2, dia_actual: 1 }).eq('telefono', senderPhone);

          console.log('🔍 Buscando episodio T1 D1...');
          const { data: episodio1, error: epError } = await supabase.from('mensajes_serie').select('*').eq('temporada', 1).eq('dia', 1).maybeSingle();

          if (epError) console.error('❌ Error DB episodios:', epError);

          if (episodio1) {
            console.log(`✅ Episodio encontrado: ${episodio1.nombre_episodio}`);

            await safeBuildTemplatePush(
              payloadsToSend,
              senderPhone,
              'envio_diario_encuentra_sentido',
              {
                imagen_header: episodio1.url_imagen_versiculo,
                nombre: user.nombre_completo,
                tema: episodio1.nombre_episodio
              },
              { wamid: messageId, step: 'envio_diario', episodio_id: episodio1.id, telefono: senderPhone },
              { fallbackText: true }
            );
          } else {
            console.log('⚠️ ALERTA: La base de datos devolvió NULL para el episodio T1 D1.');
          }
        } else if (buttonPayload === 'escuchar') {
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
        } else if (buttonPayload === 'siguiente_temporada') {
          await supabase.from('usuarios').update({
            temporada_actual: user.temporada_actual + 1,
            dia_actual: 0,
            status_id: 2
          }).eq('telefono', senderPhone);

          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: '¡Excelente decisión! Mañana a las 9:00 a.m. recibirás el primer episodio de tu nueva temporada.' } });
        } else if (buttonPayload === 'spotify') {
          await supabase.from('usuarios').update({ suscrito_spotify: true, status_id: 6 }).eq('telefono', senderPhone);
          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Aquí tienes nuestro Spotify para que escuches todas las reflexiones: [LINK_SPOTIFY]' } });
        } else if (buttonPayload === 'canal') {
          await supabase.from('usuarios').update({ status_id: 6 }).eq('telefono', senderPhone);
          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Únete a nuestro canal oficial haciendo clic aquí: www.ipucmisionesnacionales.org/canal' } });
        } else if (buttonPayload === 'acompanamiento' || buttonPayload === 'acompañamiento') {
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

            await safeBuildTemplatePush(
              payloadsToSend,
              pastorAsignado.telefono,
              'alerta_nuevo_caso',
              {
                nombre_pastor: pastorAsignado.nombre,
                nombre: user.nombre_completo,
                enlace_whatsapp: `https://wa.me/${senderPhone}`
              },
              { wamid: messageId, step: 'alerta_nuevo_caso', usuario_id: user.id, pastor_id: pastorAsignado.id, telefono: senderPhone },
              { fallbackText: true }
            );
          } else {
            await supabase.from('usuarios').update({ status_id: 3 }).eq('telefono', senderPhone);
            payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos recibido tu solicitud. Nuestro equipo te contactará a la brevedad posible.' } });
          }
        } else if (txtLower === 'amen' || txtLower === 'amén' || txtLower.includes('gracias') || txtLower.includes('bendiciones')) {
          const respuestas = [
            '¡Amén! Que Dios te bendiga 🙏',
            'Gracias a ti por leernos 🌻',
            'Dios te bendiga grandemente 🙌'
          ];
          const respuestaAzar = respuestas[Math.floor(Math.random() * respuestas.length)];
          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: respuestaAzar } });
        } else if (txtLower.includes('cancelar suscripcion') || txtLower.includes('cancelar suscripción')) {
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
        } else if (buttonPayload === 'habeas_borrar') {
          await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'BORRADO_TOTAL' });
          await supabase.from('usuarios').delete().eq('telefono', senderPhone);
          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Tus datos han sido eliminados por completo de nuestras bases de datos.' } });
        } else if (buttonPayload === 'habeas_inactivo') {
          await supabase.from('historial_bajas').insert({ telefono_usuario: senderPhone, accion_tomada: 'MARCADO_INACTIVO' });
          await supabase.from('usuarios').update({ status_id: 8 }).eq('telefono', senderPhone);
          payloadsToSend.push({ messaging_product: 'whatsapp', to: senderPhone, type: 'text', text: { body: 'Hemos pausado los envíos. No recibirás más mensajes de esta serie.' } });
        }
      }
    }

    // Antes de enviar: validar token y phone number id
    if (!WHATSAPP_TOKEN || !whatsappPhoneNumberId) {
      console.error('Falta WHATSAPP_TOKEN o whatsappPhoneNumberId. Abortando envíos.');
      return res.sendStatus(500);
    }

    if (payloadsToSend.length > 0) {
      await Promise.all(payloadsToSend.map(async (payload) => {
        try {
          // Sanitizar y loguear el payload final que se enviará a Meta
          const metaName = payload.template?.name;
          const metaDef = metaName ? TEMPLATE_MAP[metaName] : null;
          let safePayload = payload.template ? sanitizeTemplateForMeta(payload) : payload;
          safePayload = ensureButtonParams(metaDef, safePayload, payload.to);

          try {
            console.log('Payload final enviado a Meta:', JSON.stringify(safePayload, null, 2));
          } catch (e) {
            console.error('Error al serializar payload final:', e.message);
          }

          const metaResponse = await fetch(graphUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(safePayload)
          });

          if (!metaResponse.ok) {
            const errText = await metaResponse.text();
            console.error(`ERROR DE META:`, errText);

            const record = {
              template_name: payload.template?.name || null,
              values: payload.template ? payload.template.components : null,
              error_message: errText,
              context: { sent_at: new Date().toISOString(), to: payload.to, graphUrl },
              created_at: new Date().toISOString()
            };
            await recordRejectedPayload(supabase, record);
          } else {
            console.log('✅ Mensaje despachado con éxito a Meta.');
          }
        } catch (networkError) {
          console.error(`ERROR FATAL DE RED HACIA META:`, networkError.message);

          const record = {
            template_name: payload.template?.name || null,
            values: payload.template ? payload.template.components : null,
            error_message: networkError.message,
            context: { sent_at: new Date().toISOString(), to: payload.to, graphUrl },
            created_at: new Date().toISOString()
          };
          await recordRejectedPayload(supabase, record);
        }
      }));
    } else {
      console.log('ℹ️ No hay payloads preparados para enviar.');
    }

    // Responder 200 siempre que el procesamiento local haya terminado
    res.sendStatus(200);
  } catch (err) {
    console.error('Error crítico en webhook:', err);
    res.sendStatus(500);
  }
});

/**
 * EJEMPLO: llamada a cierre_encuentra_sentido con la URL de header que proporcionaste
 * Reemplaza 'https://tjjsntnmqljhbakprvjh.supabase.co/...' por la URL real si cambia.
 *
 * Nota: este ejemplo no se ejecuta automáticamente; úsalo donde corresponda en tu flujo
 * (por ejemplo, cuando detectes que el usuario finalizó la última temporada).
 */
async function ejemploEnviarCierre(payloadsToSend, senderPhone, user, messageId) {
  const imagenCierreUrl = 'https://tjjsntnmqljhbakprvjh.supabase.co/storage/v1/object/public/imagenes%20varias/f56a339e-2b87-4fef-85d0-608529d9fcc5.png';

  await safeBuildTemplatePush(
    payloadsToSend,
    senderPhone,
    'cierre_encuentra_sentido',
    {
      imagen_header: imagenCierreUrl,
      nombre: user.nombre_completo
    },
    { wamid: messageId, step: 'cierre' },
    { fallbackText: true }
  );
}

module.exports = app;
