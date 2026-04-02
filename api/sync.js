import { createClient } from '@supabase/supabase-js';
import https from 'https';

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getFudoToken() {
  const res = await httpsRequest({
    hostname: 'auth.fu.do',
    path: '/api',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET });

  if (!res.body?.token) throw new Error(`FUDO auth falló: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// Fetch paginado — para cuando data.length < pageSize (sin meta en la API de FUDO)
async function fetchAllPages(token, basePath) {
  const all = [];
  let page = 1;
  const pageSize = 250;

  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const res = await httpsRequest({
      hostname: 'api.fu.do',
      path: `/v1alpha1${basePath}${sep}page%5Bnumber%5D=${page}&page%5Bsize%5D=${pageSize}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const items = res.body?.data || [];
    all.push(...items);

    if (items.length < pageSize) break; // Última página
    page++;
    await new Promise(r => setTimeout(r, 30)); // Delay mínimo para no saturar
  }

  return all;
}

export async function syncFudo() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const token = await getFudoToken();

  // 1. Lookups pequeños en paralelo
  const [paymentMethodsData, productsData, categoriesData] = await Promise.all([
    fetchAllPages(token, '/payment-methods'),
    fetchAllPages(token, '/products'),
    fetchAllPages(token, '/product-categories')
  ]);

  // Mapas de referencia
  const pmMap = {}; // paymentMethodId → name
  for (const pm of paymentMethodsData) {
    pmMap[pm.id] = pm.attributes?.name || `Método ${pm.id}`;
  }

  const productInfo = {}; // productId → { name, categoryId }
  for (const p of productsData) {
    productInfo[p.id] = {
      name: p.attributes?.name || `Producto ${p.id}`,
      categoryId: p.relationships?.productCategory?.data?.id || null
    };
  }

  const categoryMap = {}; // categoryId → name
  for (const c of categoriesData) {
    categoryMap[c.id] = c.attributes?.name || `Cat ${c.id}`;
  }

  // 2. Data principal en paralelo (las 3 fuentes grandes)
  const [sales, payments, items] = await Promise.all([
    fetchAllPages(token, '/sales'),
    fetchAllPages(token, '/payments'),
    fetchAllPages(token, '/items')
  ]);

  // 3. Procesar ventas
  const byDay = {}, byMonth = {}, byWeek = {};
  const saleDateMap = {}; // saleId → date (solo ventas CLOSED)
  const ticketByMonth = {}, countByMonth = {};
  let totalClosed = 0, totalCanceled = 0;

  for (const sale of sales) {
    const attrs = sale.attributes || {};
    const state = attrs.saleState;

    if (state === 'CANCELED') { totalCanceled++; continue; }
    if (state !== 'CLOSED') continue;
    totalClosed++;

    const closedAt = attrs.closedAt;
    if (!closedAt) continue;
    const date = closedAt.split('T')[0];
    const total = parseFloat(attrs.total || 0);

    saleDateMap[sale.id] = date;

    if (!total) continue;

    byDay[date] = (byDay[date] || 0) + total;

    const month = date.substring(0, 7);
    byMonth[month] = (byMonth[month] || 0) + total;

    ticketByMonth[month] = (ticketByMonth[month] || 0) + total;
    countByMonth[month] = (countByMonth[month] || 0) + 1;

    // Semana (lunes)
    const d = new Date(date + 'T12:00:00');
    const dow = d.getDay();
    const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const weekKey = monday.toISOString().split('T')[0];
    byWeek[weekKey] = (byWeek[weekKey] || 0) + total;
  }

  // 4. Procesar ítems (para top productos y categorías)
  const productRevMap = {}; // productName → { name, qty, revenue, categoryId }

  for (const item of items) {
    const attrs = item.attributes || {};
    if (attrs.canceled) continue;

    const productId = item.relationships?.product?.data?.id;
    if (!productId) continue;

    const saleId = item.relationships?.sale?.data?.id;
    if (!saleId || !saleDateMap[saleId]) continue; // Solo ítems de ventas cerradas

    const prod = productInfo[productId] || { name: `Producto ${productId}`, categoryId: null };
    const qty = parseInt(attrs.quantity || 1);
    const price = parseFloat(attrs.price || 0);
    const lineTotal = price; // En FUDO, price es el total de la línea (price × qty ya incluido)

    if (!productRevMap[prod.name]) {
      productRevMap[prod.name] = { name: prod.name, qty: 0, revenue: 0, categoryId: prod.categoryId };
    }
    productRevMap[prod.name].qty += qty;
    productRevMap[prod.name].revenue += lineTotal;
  }

  const topProducts = Object.values(productRevMap).sort((a, b) => b.revenue - a.revenue);

  // Ventas por categoría
  const catRevMap = {};
  for (const p of topProducts) {
    const catId = p.categoryId;
    const catName = categoryMap[catId] || 'Sin categoría';
    if (!catRevMap[catId]) catRevMap[catId] = { name: catName, revenue: 0, qty: 0 };
    catRevMap[catId].revenue += p.revenue;
    catRevMap[catId].qty += p.qty;
  }
  const salesByCategory = Object.values(catRevMap).sort((a, b) => b.revenue - a.revenue);

  // 5. Procesar pagos
  const pmRevMap = {};
  for (const payment of payments) {
    const attrs = payment.attributes || {};
    if (attrs.canceled) continue;

    const saleId = payment.relationships?.sale?.data?.id;
    if (!saleId || !saleDateMap[saleId]) continue;

    const pmId = payment.relationships?.paymentMethod?.data?.id;
    const pmName = pmMap[pmId] || `Método ${pmId}`;
    const amount = parseFloat(attrs.amount || 0);

    if (!pmRevMap[pmName]) pmRevMap[pmName] = { name: pmName, total: 0, count: 0 };
    pmRevMap[pmName].total += amount;
    pmRevMap[pmName].count++;
  }
  const paymentsByMethod = Object.values(pmRevMap).sort((a, b) => b.total - a.total);

  // 6. Ticket promedio por mes
  const avgTicketByMonth = {};
  for (const [m, sum] of Object.entries(ticketByMonth)) {
    avgTicketByMonth[m] = countByMonth[m] ? Math.round(sum / countByMonth[m]) : 0;
  }

  const totalRevenue = Object.values(byDay).reduce((s, v) => s + v, 0);
  const avgTicket = totalClosed > 0 ? Math.round(totalRevenue / totalClosed) : 0;

  // 7. Heatmap días de la semana
  const dowMap = {};
  const DAYS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  for (const [date, total] of Object.entries(byDay)) {
    const d = new Date(date + 'T12:00:00');
    const dayName = DAYS[d.getDay()];
    if (!dowMap[dayName]) dowMap[dayName] = { day: dayName, total: 0, count: 0 };
    dowMap[dayName].total += total;
    dowMap[dayName].count++;
  }
  const heatmapDow = Object.values(dowMap).map(d => ({
    ...d,
    avg: d.count > 0 ? Math.round(d.total / d.count) : 0
  }));

  // 8. Guardar en Supabase
  const ventas_v1 = {
    byDay, byMonth, byWeek,
    topProducts: topProducts.slice(0, 500),
    avgTicketByMonth,
    stats: { totalClosed, totalCanceled, avgTicket },
    last_sync_date: new Date().toISOString()
  };

  const ventas_v2 = {
    paymentsByMethod,
    salesByCategory,
    heatmapDow,
    byMonth,
    byDay,
    last_sync_date: new Date().toISOString()
  };

  await supabase.from('deniks_cache').upsert([
    { key: 'ventas_v1', value: ventas_v1, updated_at: new Date().toISOString() },
    { key: 'ventas_v2', value: ventas_v2, updated_at: new Date().toISOString() }
  ], { onConflict: 'key' });

  return {
    success: true,
    totalClosed,
    totalCanceled,
    salesFetched: sales.length,
    itemsFetched: items.length,
    paymentsFetched: payments.length
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const result = await syncFudo();
    return res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
