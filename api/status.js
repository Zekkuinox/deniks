import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data } = await supabase
      .from('deniks_cache')
      .select('updated_at')
      .eq('key', 'ventas_v1')
      .single();

    return res.json({
      lastSync: data?.updated_at || null,
      status: data ? 'ok' : 'sin_datos'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
