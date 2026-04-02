import { createClient } from '@supabase/supabase-js';
import https from 'https';

function httpsReq(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: r.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Modo debug: ?debug=1
  if (req.query?.debug === '1') {
    const authRes = await httpsReq({
      hostname: 'auth.fu.do',
      path: '/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET });

    if (!authRes.body?.token) {
      return res.json({ step: 'auth_failed', authStatus: authRes.status, authBody: authRes.body });
    }

    const token = authRes.body.token;

    // Intentar múltiples paths para descubrir el correcto
    const paths = [
      '/v1alpha1/orders?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      '/v1/orders?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      '/v2/orders?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      '/api/orders?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      '/v1alpha1/sales?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      '/v1alpha1/transactions?page%5Bnumber%5D=1&page%5Bsize%5D=2',
    ];

    const results = {};
    for (const p of paths) {
      const r = await httpsReq({
        hostname: 'api.fu.do',
        path: p,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      results[p] = {
        status: r.status,
        keys: r.body ? Object.keys(r.body) : [],
        dataCount: Array.isArray(r.body?.data) ? r.body.data.length : null,
        meta: r.body?.meta
      };
    }

    return res.json({ authOk: true, tokenPreview: token.substring(0, 30) + '...', results });
  }

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
