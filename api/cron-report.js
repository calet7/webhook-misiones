// api/cron-report.js
module.exports = async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).send('unauthorized');
  }

  try {
    // TODO: reemplaza con la lógica real del reporte
    // ejemplo: llamar a Supabase, generar resumen, enviar notificación
    console.log('cron-report ejecutado por', req.ip, 'at', new Date().toISOString());

    // Simular trabajo breve
    await new Promise((r) => setTimeout(r, 200));

    return res.status(200).json({ ok: true, message: 'report executed' });
  } catch (err) {
    console.error('cron-report error', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
};
