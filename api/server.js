// API REST: lee tus tablas (estacion, sensor, parametro, lectura) de Azure SQL y responde JSON.
require('dotenv').config();
const http = require('http');
const sql = require('mssql');

const PORT = process.env.PORT || 3000;
const config = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: { encrypt: true },
  connectionTimeout: 30000, // por si la base está "dormida" y tarda en despertar
  requestTimeout: 30000,
};

// Una sola conexión reutilizable; si falla, se reintenta en la siguiente petición.
let poolPromise;
const getPool = () =>
  (poolPromise ??= sql.connect(config).catch((e) => { poolPromise = null; throw e; }));

// Niveles según PM2.5 (µg/m³)
const nivel = (v) =>
  v == null ? 'Sin dato' : v <= 12 ? 'Bueno' : v <= 35 ? 'Moderado' : v <= 55 ? 'Dañino para sensibles' : 'Malo';

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', // permite que la SPA (otro dominio) consuma la API
  });
  res.end(JSON.stringify(body));
};

// Lista de estaciones con la última lectura de cada contaminante que mide.
async function estaciones() {
  const pool = await getPool();
  const [e, u] = await Promise.all([
    pool.request().query(
      `SELECT id, nombre, proveedor, pais, latitud AS lat, longitud AS lon FROM estacion ORDER BY nombre`),
    pool.request().query(`
      SELECT s.estacion_id, p.nombre AS parametro, p.nombre_mostrar AS mostrar, p.unidad,
             x.fecha_hora AS hora, x.valor
      FROM sensor s
      JOIN parametro p ON p.id = s.parametro_id
      CROSS APPLY (SELECT TOP 1 l.fecha_hora, l.valor FROM lectura l
                   WHERE l.sensor_id = s.id ORDER BY l.fecha_hora DESC) x
      ORDER BY p.nombre`),
  ]);
  return e.recordset.map((est) => {
    const ultimas = u.recordset
      .filter((x) => x.estacion_id === est.id)
      .map((x) => ({ parametro: x.parametro, mostrar: x.mostrar || x.parametro, unidad: x.unidad, valor: x.valor, hora: x.hora }));
    const pm25 = ultimas.find((x) => x.parametro === 'pm25')?.valor ?? null;
    const hora = ultimas.reduce((m, x) => (!m || x.hora > m ? x.hora : m), null);
    return { ...est, ultimas, pm25, nivel: nivel(pm25), hora };
  });
}

// Lecturas recientes de una estación, una fila por hora y una columna por contaminante.
async function lecturas(id) {
  const pool = await getPool();
  const r = await pool.request().input('id', sql.Int, id).query(`
    SELECT TOP 1000 l.fecha_hora AS hora, p.nombre AS parametro, p.nombre_mostrar AS mostrar, p.unidad, l.valor
    FROM lectura l
    JOIN sensor s ON s.id = l.sensor_id
    JOIN parametro p ON p.id = s.parametro_id
    WHERE s.estacion_id = @id
    ORDER BY l.fecha_hora DESC`);
  const porHora = new Map();
  const meta = new Map();
  for (const x of r.recordset) {
    const k = x.hora.toISOString();
    if (!porHora.has(k)) porHora.set(k, {});
    porHora.get(k)[x.parametro] = x.valor;
    meta.set(x.parametro, { parametro: x.parametro, mostrar: x.mostrar || x.parametro, unidad: x.unidad });
  }
  const filas = [...porHora].slice(0, 48).map(([hora, valores]) => ({ hora, valores, nivel: nivel(valores.pm25) }));
  const usados = new Set(filas.flatMap((f) => Object.keys(f.valores)));
  const peso = (p) => (p === 'pm25' ? 0 : p === 'pm10' ? 1 : 2);
  const columnas = [...meta.values()]
    .filter((c) => usados.has(c.parametro))
    .sort((a, b) => peso(a.parametro) - peso(b.parametro) || a.parametro.localeCompare(b.parametro));
  return { columnas, filas };
}

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      if (path === '/health') return send(res, 200, { ok: true });
      if (path === '/api/estaciones') return send(res, 200, await estaciones());
      const m = path.match(/^\/api\/estaciones\/(\d+)\/lecturas$/);
      if (m) return send(res, 200, await lecturas(Number(m[1])));
      send(res, 404, { error: 'No encontrado' });
    } catch (e) {
      console.error('Error:', e.message);
      send(res, 500, { error: 'No se pudo consultar la base de datos' });
    }
  })
  .listen(PORT, () => console.log('API escuchando en el puerto ' + PORT));
