import https from 'https';

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

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // 1. Auth FUDO
  const authRes = await httpsRequest({
    hostname: 'auth.fu.do',
    path: '/api',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET });

  if (!authRes.body?.token) {
    return res.json({ step: 'auth_failed', authStatus: authRes.status, authBody: authRes.body });
  }

  const token = authRes.body.token;

  // 2. Orders sin filtro (primera página)
  const ordersRes = await httpsRequest({
    hostname: 'api.fu.do',
    path: '/v1alpha1/orders?page%5Bnumber%5D=1&page%5Bsize%5D=3',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // 3. Orders con filtro closed
  const ordersClosedRes = await httpsRequest({
    hostname: 'api.fu.do',
    path: '/v1alpha1/orders?filter%5Bstatus%5D=closed&page%5Bnumber%5D=1&page%5Bsize%5D=3',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  return res.json({
    authOk: true,
    tokenPreview: token.substring(0, 30) + '...',
    orders: {
      status: ordersRes.status,
      dataCount: Array.isArray(ordersRes.body?.data) ? ordersRes.body.data.length : 'no array',
      meta: ordersRes.body?.meta,
      sample: ordersRes.body?.data?.[0] || ordersRes.body
    },
    ordersClosed: {
      status: ordersClosedRes.status,
      dataCount: Array.isArray(ordersClosedRes.body?.data) ? ordersClosedRes.body.data.length : 'no array',
      meta: ordersClosedRes.body?.meta,
      sample: ordersClosedRes.body?.data?.[0] || ordersClosedRes.body
    }
  });
}
