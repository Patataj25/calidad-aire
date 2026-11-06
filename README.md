# Calidad del aire por estación (avance 2)
- `api/` API REST (Node.js) en contenedor Docker. Lee de Azure SQL (tablas estacion, sensor, parametro, lectura).
- `web/` SPA (HTML + JS). Cambia la constante `API` en `web/index.html` por la URL de la API desplegada.
Endpoints: `GET /health`, `GET /api/estaciones`, `GET /api/estaciones/:id/lecturas`
