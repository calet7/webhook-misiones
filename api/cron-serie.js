const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

/**
 * Helper: registra payloads rechazados de forma resiliente.
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
 * Builder simple para plantillas nombradas (envio_diario_encuentra_sentido).
 * Devuelve el payload listo para enviar a Meta (placeholders nombrados).
 */
function buildEnvioDiarioPayload(to, imageUrl, nombre, tema) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'envio_diario_encuentra_sentido',
      language: { code: 'es_CO' },
      components: [
        {
          type: 'header',
          parameters: [
            { type: 'image', name: 'imagen_header', image: { link: String(imageUrl) } }
          ]
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', name: 'nombre', text: String(nombre || '') },
            { type: 'text', name: 'tema', text: String(tema || '') }
          ]
        }
      ]
    }
  };
}

/**
 * Handler del cron-serie con reservas atómicas en BD (RPCs)
 *
 * Requisitos en la BD (ejecutar previamente):
 * - Función reserve_next_send(p_usuario_id bigint, p_ttl_seconds integer DEFAULT 120)
 * - Función finalize_send(p_usuario_id bigint, p_reservation_token uuid, p_new_dia integer)
 * - Función release_reservation(p_usuario_id bigint, p_reservation_token uuid)
 * - Columnas en usuarios: ultimo_envio timestamptz, reserved_until timestamptz, reservation_token uuid
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
  if (req.query.secret !== CRON_SECRET) return res.status(403).send('Forbidden');

  try {
    // 1) Cargar usuarios activos (status_id = 2) que no completaron temporada
    const { data: usersActivos, error: dbError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('status_id', 2)
      .lt('dia_actual', 6);

    if (dbError) {
      console.error('Error consultando usuarios en BD:', dbError);
      return res.status(500).send('Error interno BD');
    }

    if (!usersActivos || usersActivos.length === 0) {
      return res.status(200).send('Cron ejecutado: Sin usuarios pendientes para hoy.');
    }

    // 2) Descargar catálogo de mensajes
    const { data: mensajesCat, error: errMensajes } = await supabase
      .from('mensajes_serie')
      .select('*');

    if (errMensajes) {
      console.error('Error cargando catálogo de mensajes:', errMensajes);
      return res.status(500).send('Error de catálogo BD');
    }

    const mapaMensajes = {};
    for (const m of mensajesCat) {
      mapaMensajes[`${m.temporada}_${m.dia}`] = m;
    }

    let enviosExitosos = 0;

    // 3) Procesar cola: reservar en BD antes de enviar a Meta
    for (const user of usersActivos) {
      if (!user.telefono) continue;

      const temporadaActual = user.temporada_actual || 1;
      const diaAEnviar = (Number(user.dia_actual) || 0) + 1;

      const dataEpisodio = mapaMensajes[`${temporadaActual}_${diaAEnviar}`];
      if (!dataEpisodio) {
        console.error(`Falta contenido para T${temporadaActual} D${diaAEnviar} (User: ${user.telefono})`);
        continue;
      }

      // 3.a) Intentar reservar el envío atómicamente en la BD (RPC)
      let reservationToken = null;
      try {
        const { data: reserveData, error: reserveErr } = await supabase
          .rpc('reserve_next_send', { p_usuario_id: user.id, p_ttl_seconds: 180 });

        if (reserveErr) {
          console.error(`Error RPC reserve_next_send para usuario ${user.id}:`, reserveErr);
          // registrar y saltar usuario
          await recordRejectedPayload(supabase, {
            template_name: 'reserve_next_send',
            values: { usuario_id: user.id },
            error_message: reserveErr.message || JSON.stringify(reserveErr),
            context: { usuario_id: user.id, telefono: user.telefono },
            created_at: new Date().toISOString()
          });
          continue;
        }

        // reserveData puede ser null/[] si no se pudo reservar
        if (!reserveData || (Array.isArray(reserveData) && reserveData.length === 0)) {
          // Ya se envió hoy o está reservado por otra instancia
          console.log(`Reserva no concedida para usuario ${user.telefono} (posible envío hoy o reserva activa).`);
          continue;
        }

        // Si la función devuelve un registro, extraer token
        const rec = Array.isArray(reserveData) ? reserveData[0] : reserveData;
        reservationToken = rec?.reservation_token || rec?.reservationToken || null;

        if (!reservationToken) {
          console.log(`Reserva sin token para usuario ${user.telefono}; saltando.`);
          continue;
        }
      } catch (rpcErr) {
        console.error('Excepción al llamar reserve_next_send:', rpcErr);
        await recordRejectedPayload(supabase, {
          template_name: 'reserve_next_send',
          values: { usuario_id: user.id },
          error_message: rpcErr?.message || String(rpcErr),
          context: { usuario_id: user.id, telefono: user.telefono },
          created_at: new Date().toISOString()
        });
        continue;
      }

      // 3.b) Construir payload nombrado (coherente con TEMPLATE_MAP)
      let payloadPlantilla;
      try {
        payloadPlantilla = buildEnvioDiarioPayload(
          user.telefono,
          dataEpisodio.url_imagen_versiculo,
          user.nombre_completo || '',
          dataEpisodio.nombre_episodio || ''
        );
      } catch (buildErr) {
        console.error(`Error construyendo payload para ${user.telefono}:`, buildErr.message);
        await recordRejectedPayload(supabase, {
          template_name: 'envio_diario_encuentra_sentido',
          values: {
            imagen_header: dataEpisodio.url_imagen_versiculo,
            nombre: user.nombre_completo,
            tema: dataEpisodio.nombre_episodio
          },
          error_message: buildErr.message,
          context: { usuario_id: user.id, telefono: user.telefono, temporada: temporadaActual, dia: diaAEnviar },
          created_at: new Date().toISOString()
        });

        // liberar reserva (intentar) y continuar
        try {
          await supabase.rpc('release_reservation', { p_usuario_id: user.id, p_reservation_token: reservationToken });
        } catch (releaseErr) {
          console.error('Error liberando reserva tras fallo de build:', releaseErr);
        }
        continue;
      }

      // 3.c) Enviar a Meta (Graph API v26.0)
      const graphUrl = `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
      try {
        const metaResponse = await fetch(graphUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payloadPlantilla)
        });

        if (!metaResponse.ok) {
          const errText = await metaResponse.text();
          console.error(`ERROR META (Día ${diaAEnviar} | Tel: ${user.telefono}):`, errText);

          // Registrar fallo y liberar reserva
          await recordRejectedPayload(supabase, {
            template_name: 'envio_diario_encuentra_sentido',
            values: payloadPlantilla.template,
            error_message: errText,
            context: { usuario_id: user.id, telefono: user.telefono, temporada: temporadaActual, dia: diaAEnviar, graphUrl },
            created_at: new Date().toISOString()
          });

          try {
            await supabase.rpc('release_reservation', { p_usuario_id: user.id, p_reservation_token: reservationToken });
          } catch (releaseErr) {
            console.error('Error liberando reserva tras fallo Meta:', releaseErr);
          }

          // No avanzamos el día para reintento mañana
          continue;
        }

        // 3.d) Si Meta respondió OK, finalizar atómicamente en BD (finalize_send RPC)
        try {
          const { data: finalizeData, error: finalizeErr } = await supabase
            .rpc('finalize_send', {
              p_usuario_id: user.id,
              p_reservation_token: reservationToken,
              p_new_dia: diaAEnviar
            });

          if (finalizeErr) {
            console.error(`Error RPC finalize_send para usuario ${user.id}:`, finalizeErr);
            // Registrar y no reintentar el envío (ya fue enviado); intentar finalizar varias veces podría ser la estrategia,
            // pero no reenvíes el mensaje a Meta.
            await recordRejectedPayload(supabase, {
              template_name: 'finalize_send',
              values: { usuario_id: user.id, reservation_token: reservationToken, new_dia: diaAEnviar },
              error_message: finalizeErr.message || JSON.stringify(finalizeErr),
              context: { usuario_id: user.id, telefono: user.telefono },
              created_at: new Date().toISOString()
            });
            // Intentar release por si finalize falló y dejó la reserva
            try {
              await supabase.rpc('release_reservation', { p_usuario_id: user.id, p_reservation_token: reservationToken });
            } catch (releaseErr) {
              console.error('Error liberando reserva tras fallo finalize:', releaseErr);
            }
            continue;
          }

          // finalizeData puede ser booleano o array; normalizar
          const finalized = (finalizeData === true) || (Array.isArray(finalizeData) && finalizeData[0] === true) || (finalizeData && finalizeData === 't');

          if (!finalized) {
            console.error(`Finalize_send devolvió false para usuario ${user.id}.`);
            await recordRejectedPayload(supabase, {
              template_name: 'finalize_send',
              values: { usuario_id: user.id, reservation_token: reservationToken, new_dia: diaAEnviar },
              error_message: 'finalize_send returned false',
              context: { usuario_id: user.id, telefono: user.telefono },
              created_at: new Date().toISOString()
            });
            // No intentar reenvío; la reserva puede haber expirado o sido tomada por otro proceso
            continue;
          }

          // Éxito completo: contamos el envío
          enviosExitosos++;
        } catch (finalizeEx) {
          console.error('Excepción al llamar finalize_send:', finalizeEx);
          await recordRejectedPayload(supabase, {
            template_name: 'finalize_send',
            values: { usuario_id: user.id, reservation_token: reservationToken, new_dia: diaAEnviar },
            error_message: finalizeEx?.message || String(finalizeEx),
            context: { usuario_id: user.id, telefono: user.telefono },
            created_at: new Date().toISOString()
          });
          // Intentar liberar reserva por seguridad
          try {
            await supabase.rpc('release_reservation', { p_usuario_id: user.id, p_reservation_token: reservationToken });
          } catch (releaseErr) {
            console.error('Error liberando reserva tras excepción finalize:', releaseErr);
          }
          continue;
        }
      } catch (networkError) {
        console.error(`ERROR RED al enviar a Meta (Tel: ${user.telefono}):`, networkError.message);

        await recordRejectedPayload(supabase, {
          template_name: 'envio_diario_encuentra_sentido',
          values: payloadPlantilla ? payloadPlantilla.template : null,
          error_message: networkError.message,
          context: { usuario_id: user.id, telefono: user.telefono, temporada: temporadaActual, dia: diaAEnviar },
          created_at: new Date().toISOString()
        });

        // Intentar liberar reserva
        try {
          await supabase.rpc('release_reservation', { p_usuario_id: user.id, p_reservation_token: reservationToken });
        } catch (releaseErr) {
          console.error('Error liberando reserva tras fallo de red:', releaseErr);
        }

        continue;
      }
    }

    return res.status(200).send(`Cron ejecutado. Mensajes enviados con éxito: ${enviosExitosos}/${usersActivos.length}`);
  } catch (err) {
    console.error('Error crítico en ejecución del Cron:', err);
    return res.status(500).send('Falla en la ejecución del servidor');
  }
};
