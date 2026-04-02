import { syncFudo } from './sync.js';

export default async function handler(req, res) {
  // Vercel solo llama a crons con método GET y header x-vercel-cron
  if (!req.headers['x-vercel-cron'] && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const result = await syncFudo();
    console.log('Cron sync completado:', result);
    return res.json(result);
  } catch (err) {
    console.error('Cron sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
