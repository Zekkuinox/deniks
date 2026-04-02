import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key requerida' });

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from('deniks_cache')
      .select('value, updated_at')
      .eq('key', key)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Sin datos en caché' });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.json({ data: data.value, updatedAt: data.updated_at });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
