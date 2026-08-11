const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

module.exports = async function handler(req, res) {
    // 1. Validación de seguridad del Cron (Protege el endpoint de ejecuciones externas)
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
    if (req.query.secret !== CRON_SECRET) return res.status(403).send('Forbidden');

    try {
        // 2. Extraer usuarios ACTIVOS (status_id = 2) que NO han completado su temporada (dia_actual < 6)
        // Eliminamos el obsoleto "isToday" que generaba falsos positivos.
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

        // 3. Descargar el catálogo completo de mensajes (Minimiza llamadas a la BD en el bucle)
        const { data: mensajesCat, error: errMensajes } = await supabase
            .from('mensajes_serie')
            .select('*');

        if (errMensajes) {
            console.error('Error cargando catálogo de mensajes:', errMensajes);
            return res.status(500).send('Error de catálogo BD');
        }

        // Crear mapa para búsqueda instantánea
        const mapaMensajes = {};
        for (const m of mensajesCat) {
            mapaMensajes[`${m.temporada}_${m.dia}`] = m;
        }

        let enviosExitosos = 0;

        // 4. Procesar la cola de envíos
        for (const user of usersActivos) {
            if (!user.telefono) continue;

            const temporadaActual = user.temporada_actual || 1;
            const diaAEnviar = (Number(user.dia_actual) || 0) + 1;

            const dataEpisodio = mapaMensajes[`${temporadaActual}_${diaAEnviar}`];
            if (!dataEpisodio) {
                console.error(`Falta contenido para T${temporadaActual} D${diaAEnviar} (User: ${user.telefono})`);
                continue; 
            }

            // --- PAYLOAD ALINEADO A LA PLANTILLA APROBADA ---
            // Plantilla: envio_diario_encuentra_sentido
            // Variables: {{1}} = nombre, {{2}} = tema
            const payloadPlantilla = {
                messaging_product: 'whatsapp',
                to: user.telefono,
                type: 'template',
                template: {
                    name: 'envio_diario_encuentra_sentido',
                    language: { code: 'es' },
                    components: [
                        { 
                            type: 'header', 
                            parameters: [
                                { type: 'image', image: { link: dataEpisodio.url_imagen_versiculo } }
                            ] 
                        },
                        { 
                            type: 'body', 
                            parameters: [
                                { type: 'text', text: user.nombre_completo },   // {{nombre}}
                                { type: 'text', text: dataEpisodio.nombre_episodio } // {{tema}}
                            ]
                        }
                    ]
                }
            };

            // Ejecutar envío a la API de Graph
            const metaResponse = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
                continue; // Si Meta falla, no avanzamos el día para que se reintente mañana
            }

            // 5. Transición de Día
            // Actualizamos el registro del usuario sumándole el día completado
            await supabase.from('usuarios')
                .update({ 
                    dia_actual: diaAEnviar
                })
                .eq('id', user.id);

            enviosExitosos++;
        }

        return res.status(200).send(`Cron ejecutado. Mensajes enviados con éxito: ${enviosExitosos}/${usersActivos.length}`);

    } catch (err) {
        console.error('Error crítico en ejecución del Cron:', err);
        return res.status(500).send('Falla en la ejecución del servidor');
    }
};