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

    // Check paginación (links vs meta) y filtros por fecha
    const salesFullRes = await httpsReq({
      hostname: 'api.fu.do',
      path: '/v1alpha1/sales?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    // Filtros de fecha para incremental sync
    const salesDateFilterRes = await httpsReq({
      hostname: 'api.fu.do',
      path: '/v1alpha1/sales?filter%5BclosedAt%5D%5Bgte%5D=2026-01-01&page%5Bnumber%5D=1&page%5Bsize%5D=2',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const salesDateFilter2Res = await httpsReq({
      hostname: 'api.fu.do',
      path: '/v1alpha1/sales?filter%5BclosedAtFrom%5D=2026-01-01&page%5Bnumber%5D=1&page%5Bsize%5D=2',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    // Obtener product-methods y products
    const pmRes = await httpsReq({
      hostname: 'api.fu.do',
      path: '/v1alpha1/payment-methods?page%5Bnumber%5D=1&page%5Bsize%5D=5',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const productsRes = await httpsReq({
      hostname: 'api.fu.do',
      path: '/v1alpha1/products?page%5Bnumber%5D=1&page%5Bsize%5D=2',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    return res.json({
      authOk: true,
      salesTopKeys: salesFullRes.body ? Object.keys(salesFullRes.body) : [],
      salesMeta: salesFullRes.body?.meta,
      salesLinks: salesFullRes.body?.links,
      salesTotal: salesFullRes.body?.meta?.page?.total || salesFullRes.body?.meta?.total,
      dateFilter: {
        gte: { status: salesDateFilterRes.status, count: salesDateFilterRes.body?.data?.length },
        from: { status: salesDateFilter2Res.status, count: salesDateFilter2Res.body?.data?.length }
      },
      paymentMethods: pmRes.body?.data?.map(p => ({ id: p.id, ...p.attributes })) || null,
      productSample: productsRes.body?.data?.[0] || null
    });
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
