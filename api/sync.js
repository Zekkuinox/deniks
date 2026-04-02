import { createClient } from '@supabase/supabase-js';
import https from 'https';

// Helper: HTTP request como Promise
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

// Autenticar con FUDO
async function getFudoToken() {
  const res = await httpsRequest({
    hostname: 'auth.fu.do',
    path: '/api',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { apiKey: process.env.FUDO_API_KEY, apiSecret: process.env.FUDO_API_SECRET });

  if (!res.body?.token) throw new Error('FUDO auth falló');
  return res.body.token;
}

// Fetch paginado de FUDO
async function fetchAllPages(token, endpoint) {
  const all = [];
  let page = 1;

  while (true) {
    const res = await httpsRequest({
      hostname: 'api.fu.do',
      path: `/v1alpha1${endpoint}${endpoint.includes('?') ? '&' : '?'}page%5Bnumber%5D=${page}&page%5Bsize%5D=250`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const items = res.body?.data || [];
    all.push(...items);

    const totalPages = res.body?.meta?.page?.totalPages || 1;
    if (page >= totalPages) break;
    page++;
    await new Promise(r => setTimeout(r, 150)); // rate limit
  }

  return all;
}

// Función principal de sync
export async function syncFudo() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Obtener datos existentes de Supabase
  const { data: existingV1 } = await supabase
    .from('deniks_cache')
    .select('value')
    .eq('key', 'ventas_v1')
    .single();

  const { data: existingV2 } = await supabase
    .from('deniks_cache')
    .select('value')
    .eq('key', 'ventas_v2')
    .single();

  // Determinar última fecha conocida
  let lastDate = '2023-10-01';
  if (existingV1?.value?.byDay) {
    const dates = Object.keys(existingV1.value.byDay).sort();
    if (dates.length > 0) lastDate = dates[dates.length - 1];
  }

  console.log(`Sync incremental desde: ${lastDate}`);

  const token = await getFudoToken();

  // Fetch orders (ventas) - todos con status closed
  const orders = await fetchAllPages(token, '/orders?filter%5Bstatus%5D=closed');

  // Fetch payments
  const payments = await fetchAllPages(token, '/payments');

  // Fetch order-items
  const orderItems = await fetchAllPages(token, '/order-items');

  // Procesar datos
  const byDay = { ...(existingV1?.value?.byDay || {}) };
  const byMonth = { ...(existingV1?.value?.byMonth || {}) };
  const byWeek = { ...(existingV1?.value?.byWeek || {}) };
  const productMap = {};
  let totalClosed = 0;
  let totalCanceled = 0;

  for (const order of orders) {
    const attrs = order.attributes || {};
    const status = attrs.status;
    if (status === 'canceled') { totalCanceled++; continue; }
    if (status !== 'closed') continue;
    totalClosed++;

    const closedAt = attrs.closedAt || attrs.closed_at || attrs.createdAt;
    if (!closedAt) continue;
    const date = closedAt.split('T')[0];
    const total = parseFloat(attrs.total || attrs.totalPrice || 0);
    if (!total || isNaN(total)) continue;

    // byDay
    byDay[date] = (byDay[date] || 0) + total;

    // byMonth
    const month = date.substring(0, 7);
    byMonth[month] = (byMonth[month] || 0) + total;

    // byWeek - lunes de la semana
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    const weekKey = monday.toISOString().split('T')[0];
    byWeek[weekKey] = (byWeek[weekKey] || 0) + total;
  }

  // Procesar order-items para top products
  const existingProducts = existingV1?.value?.topProducts || [];
  for (const p of existingProducts) {
    productMap[p.name] = { name: p.name, qty: p.qty, revenue: p.revenue };
  }

  for (const item of orderItems) {
    const attrs = item.attributes || {};
    const name = attrs.productName || attrs.name;
    if (!name) continue;
    const qty = parseInt(attrs.quantity || 1);
    const price = parseFloat(attrs.unitPrice || attrs.price || 0) * qty;
    if (!productMap[name]) productMap[name] = { name, qty: 0, revenue: 0 };
    productMap[name].qty += qty;
    productMap[name].revenue += price;
  }

  const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue);

  // Calcular ticket promedio por mes
  const ticketByMonth = {};
  const countByMonth = {};
  for (const order of orders) {
    const attrs = order.attributes || {};
    if (attrs.status !== 'closed') continue;
    const closedAt = attrs.closedAt || attrs.closed_at;
    if (!closedAt) continue;
    const month = closedAt.substring(0, 7);
    const total = parseFloat(attrs.total || 0);
    if (!total) continue;
    ticketByMonth[month] = (ticketByMonth[month] || 0) + total;
    countByMonth[month] = (countByMonth[month] || 0) + 1;
  }
  const avgTicketByMonth = {};
  for (const [m, sum] of Object.entries(ticketByMonth)) {
    avgTicketByMonth[m] = countByMonth[m] ? Math.round(sum / countByMonth[m]) : 0;
  }

  const totalRevenue = Object.values(byDay).reduce((s, v) => s + v, 0);
  const avgTicket = totalClosed > 0 ? Math.round(totalRevenue / totalClosed) : 0;

  const ventas_v1 = {
    byDay, byMonth, byWeek,
    topProducts: topProducts.slice(0, 500),
    avgTicketByMonth,
    stats: { totalClosed, totalCanceled, avgTicket },
    last_sync_date: new Date().toISOString()
  };

  // Procesar pagos (v2)
  const paymentMap = {};
  for (const p of payments) {
    const attrs = p.attributes || {};
    const name = attrs.paymentMethodName || attrs.name || 'Otro';
    const amount = parseFloat(attrs.amount || attrs.total || 0);
    if (!paymentMap[name]) paymentMap[name] = { name, total: 0, count: 0 };
    paymentMap[name].total += amount;
    paymentMap[name].count++;
  }
  const paymentsByMethod = Object.values(paymentMap).sort((a, b) => b.total - a.total);

  // Categorías - re-usar de v2 existente si no cambia (order-items no tienen categoría directamente)
  const salesByCategory = existingV2?.value?.salesByCategory || [];

  // Heatmap día de semana
  const dowMap = {};
  for (const [date, total] of Object.entries(byDay)) {
    const d = new Date(date + 'T12:00:00');
    const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const dayName = days[d.getDay()];
    if (!dowMap[dayName]) dowMap[dayName] = { day: dayName, total: 0, count: 0 };
    dowMap[dayName].total += total;
    dowMap[dayName].count++;
  }
  const heatmapDow = Object.values(dowMap).map(d => ({
    ...d,
    avg: d.count > 0 ? Math.round(d.total / d.count) : 0
  }));

  const ventas_v2 = {
    paymentsByMethod,
    salesByCategory,
    heatmapDow,
    byMonth,
    byDay,
    last_sync_date: new Date().toISOString()
  };

  // Guardar en Supabase
  await supabase.from('deniks_cache').upsert([
    { key: 'ventas_v1', value: ventas_v1, updated_at: new Date().toISOString() },
    { key: 'ventas_v2', value: ventas_v2, updated_at: new Date().toISOString() }
  ], { onConflict: 'key' });

  return { success: true, totalClosed, totalCanceled, lastDate };
}

// Handler HTTP
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // TODO: En producción el botón "Actualizar" del sync-bar no pasará el CRON_SECRET.
  // Para habilitarlo desde el frontend, considerar un endpoint separado con autenticación
  // por sesión, o exponer un token público de solo-sync con rate limiting.

  try {
    const result = await syncFudo();
    return res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
