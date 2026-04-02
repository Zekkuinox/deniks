// Endpoint temporal de diagnóstico — borrar después de testear
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const https = (await import('https')).default;

  function httpsRequest(options, body = null) {
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

  // 1. Auth
  const authRes = await httpsRequest({
    hostname: 'auth.fu.do',
    path: '/api',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET });

  if (!authRes.body?.token) {
    return res.json({ step: 'auth', authStatus: authRes.status, authBody: authRes.body });
  }

  const token = authRes.body.token;

  // 2. Primera página de orders (sin filtro)
  const ordersRes = await httpsRequest({
    hostname: 'api.fu.do',
    path: '/v1alpha1/orders?page%5Bnumber%5D=1&page%5Bsize%5D=5',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // 3. Primera página con filtro closed
  const ordersFilteredRes = await httpsRequest({
    hostname: 'api.fu.do',
    path: '/v1alpha1/orders?filter%5Bstatus%5D=closed&page%5Bnumber%5D=1&page%5Bsize%5D=5',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  return res.json({
    step: 'ok',
    authStatus: authRes.status,
    tokenPreview: token.substring(0, 20) + '...',
    orders: {
      status: ordersRes.status,
      dataCount: ordersRes.body?.data?.length ?? 'no data field',
      meta: ordersRes.body?.meta,
      firstItem: ordersRes.body?.data?.[0] ?? ordersRes.body,
    },
    ordersFiltered: {
      status: ordersFilteredRes.status,
      dataCount: ordersFilteredRes.body?.data?.length ?? 'no data field',
      meta: ordersFilteredRes.body?.meta,
      firstItem: ordersFilteredRes.body?.data?.[0] ?? ordersFilteredRes.body,
    }
  });
}
