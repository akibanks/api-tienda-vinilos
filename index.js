// ══════════════════════════════════════════════════════════
//  VinylVibes — Backend v3
//
//  Variables de entorno requeridas en Render:
//    DATABASE_URL     → connection string de Neon
//    JWT_SECRET       → clave secreta para firmar tokens
//    CORS_ORIGIN      → dominios permitidos
//    REDIS_URL        → URL interna de Redis en Render
//    DISCOGS_TOKEN    → token de Discogs API
//    YOUTUBE_API_KEY  → clave de YouTube Data API v3
//    LASTFM_API_KEY   → clave de Last.fm API
// ══════════════════════════════════════════════════════════

require('dotenv').config();

const cors      = require('cors');
const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Redis     = require('ioredis');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const redis  = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => console.warn('Redis error:', err.message));

const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_EXPIRY      = '7d';
const DISCOGS_TOKEN   = process.env.DISCOGS_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const LASTFM_API_KEY  = process.env.LASTFM_API_KEY;

const DISCOGS_HEADERS = {
  'Authorization': `Discogs token=${DISCOGS_TOKEN}`,
  'User-Agent':    'VinylVibes/1.0 +https://akibanks.github.io',
};

// TTL del caché en segundos
const TTL = {
  BUSQUEDA:        60 * 60,
  GENERO:          60 * 60 * 24,
  RECIENTES:       60 * 60 * 24,
  DISCO:           60 * 60 * 24 * 7,
  HISTORIA:        60 * 60 * 24 * 7,
  VIDEO:           60 * 60 * 24 * 7,
  RECOMENDACIONES: 60 * 60,
};

const app = express();


// ── MIDDLEWARES ───────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`Origen no permitido por CORS: ${origin}`));
    }
  },
  credentials: true,
}));

app.use(express.json());

app.use(rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.' },
}));

const limitarAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
});


// ── MIDDLEWARES DE AUTH ───────────────────────────────────

function verificarToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token de autenticación requerido.' });
  try {
    req.usuario = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
  }
}

function soloAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin')
    return res.status(403).json({ error: 'Acceso denegado: se requieren permisos de administrador.' });
  next();
}


// ── HELPERS ───────────────────────────────────────────────

/** Calcula el precio del disco según popularidad y año. */
function calcularPrecio(anio, have = 0, want = 0) {
  // Base por año
  let base;
  if (!anio)        base = 24.99;
  else if (anio >= 2000) base = 19.99;
  else if (anio >= 1980) base = 29.99;
  else if (anio >= 1960) base = 34.99;
  else                   base = 39.99;

  // Ajuste por popularidad (ratio want/have)
  const ratio = have > 0 ? want / have : 0;
  if (ratio >= 1.5)      base = Math.min(base * 1.4, base + 15); // muy deseado
  else if (ratio >= 0.8) base = Math.min(base * 1.2, base + 8);  // bastante deseado
  else if (ratio <= 0.1) base = Math.max(base * 0.85, base - 5); // poco deseado

  return Math.round(base * 100) / 100;
}

/** Obtiene estadísticas de popularidad de Discogs. */
async function obtenerStats(discogsId) {
  try {
    const resp = await fetch(
      `https://api.discogs.com/releases/${discogsId}/stats`,
      { headers: DISCOGS_HEADERS }
    );
    if (!resp.ok) return { have: 0, want: 0 };
    const data = await resp.json();
    return {
      have: data.num_have || 0,
      want: data.num_want || 0,
    };
  } catch (e) {
    return { have: 0, want: 0 };
  }
}

/** Limpia el nombre del artista quitando el sufijo (2), (3), etc. de Discogs. */
function limpiarArtista(nombre) {
  return nombre.replace(/\s*\(\d+\)$/, '').trim();
}

/** Obtiene del caché o ejecuta fn() y guarda el resultado en Redis. */
async function cachear(clave, ttl, fn) {
  try {
    const cached = await redis.get(clave);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn('Redis get error:', e.message);
  }

  const resultado = await fn();

  try {
    if (resultado !== null) {
      await redis.setex(clave, ttl, JSON.stringify(resultado));
    }
  } catch (e) {
    console.warn('Redis set error:', e.message);
  }

  return resultado;
}

/** Formatea un resultado de búsqueda de Discogs al shape del frontend. */
function formatearResultadoDiscogs(item) {
  let titulo  = item.title || '';
  let artista = '';

  if (titulo.includes(' - ')) {
    artista = titulo.split(' - ')[0].trim();
    titulo  = titulo.split(' - ').slice(1).join(' - ').trim();
  }

  const anio = item.year || null;

  const have = item.community?.have || 0;
  const want = item.community?.want || 0;

  return {
    discogs_id: String(item.id),
    titulo,
    artista:    artista || null,
    anio,
    genero:     item.genre?.[0]  || null,
    estilo:     item.style?.[0]  || null,
    imagen_url: item.cover_image || null,
    precio:     calcularPrecio(anio, have, want),
    have,
    want,
  };
}


// ══════════════════════════════════════════════════════════
//  AUTH — /registro  /login
// ══════════════════════════════════════════════════════════

app.post('/registro', limitarAuth, async (req, res) => {
  const { nombre_usuario, password } = req.body;

  if (!nombre_usuario?.trim() || !password)
    return res.status(400).json({ error: 'Nombre de usuario y contraseña son requeridos.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

  try {
    const existe = await prisma.usuario.findUnique({
      where: { nombre: nombre_usuario.trim() },
    });
    if (existe)
      return res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });

    const hash              = await bcrypt.hash(password, 10);
    const correoPlaceholder = `${nombre_usuario.trim()}@vinylvibes.local`;

    await prisma.usuario.create({
      data: {
        nombre:     nombre_usuario.trim(),
        correo:     correoPlaceholder,
        contrasena: hash,
        rol:        'cliente',
      },
    });

    res.status(201).json({ mensaje: 'Usuario creado exitosamente.' });
  } catch (err) {
    console.error('REGISTRO:', err.message);
    res.status(500).json({ error: 'Error al crear la cuenta.' });
  }
});


app.post('/login', limitarAuth, async (req, res) => {
  const { nombre_usuario, password } = req.body;

  if (!nombre_usuario?.trim() || !password)
    return res.status(400).json({ error: 'Nombre y contraseña son requeridos.' });

  try {
    const usuario = await prisma.usuario.findUnique({
      where: { nombre: nombre_usuario.trim() },
    });

    if (!usuario)
      return res.status(401).json({ error: 'Usuario no encontrado.' });

    const esCorrecta = await bcrypt.compare(password, usuario.contrasena);
    if (!esCorrecta)
      return res.status(401).json({ error: 'Contraseña incorrecta.' });

    const token = jwt.sign(
      { id: usuario.id_usuario, nombre: usuario.nombre, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      token,
      nombre:   usuario.nombre,
      es_admin: usuario.rol === 'admin',
    });
  } catch (err) {
    console.error('LOGIN:', err.message);
    res.status(500).json({ error: 'Error en el servidor.' });
  }
});


// ══════════════════════════════════════════════════════════
//  DISCOGS — Búsqueda y catálogo
// ══════════════════════════════════════════════════════════

// GET /buscar?q=query&pagina=1
app.get('/buscar', async (req, res) => {
  const { q, pagina = 1 } = req.query;
  if (!q?.trim())
    return res.status(400).json({ error: 'El parámetro q es requerido.' });

  const clave = `buscar:${q.trim().toLowerCase()}:${pagina}`;

  try {
    const resultado = await cachear(clave, TTL.BUSQUEDA, async () => {
      const url  = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=20&page=${pagina}`;
      const resp = await fetch(url, { headers: DISCOGS_HEADERS });
      const data = await resp.json();

      return {
        resultados: (data.results || []).map(formatearResultadoDiscogs),
        total:      data.pagination?.items || 0,
        paginas:    data.pagination?.pages || 1,
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('GET /buscar:', err.message);
    res.status(500).json({ error: 'Error al buscar en Discogs.' });
  }
});


// GET /recientes
app.get('/recientes', async (req, res) => {
  const clave = 'recientes';

  try {
    const resultado = await cachear(clave, TTL.RECIENTES, async () => {
      const anioActual = new Date().getFullYear();
      const url  = `https://api.discogs.com/database/search?year=${anioActual}&type=release&sort=date_added&sort_order=desc&per_page=20&page=1`;
      const resp = await fetch(url, { headers: DISCOGS_HEADERS });
      const data = await resp.json();
      return (data.results || []).map(formatearResultadoDiscogs);
    });

    res.json(resultado);
  } catch (err) {
    console.error('GET /recientes:', err.message);
    res.status(500).json({ error: 'Error al obtener discos recientes.' });
  }
});


// GET /genero/:genero?pagina=1
app.get('/genero/:genero', async (req, res) => {
  const { genero }   = req.params;
  const pagina       = parseInt(req.query.pagina) || 1;
  const clave        = `genero:${genero.toLowerCase()}:${pagina}`;

  try {
    const resultado = await cachear(clave, TTL.GENERO, async () => {
      const url  = `https://api.discogs.com/database/search?genre=${encodeURIComponent(genero)}&type=release&sort=have&sort_order=desc&per_page=20&page=${pagina}`;
      const resp = await fetch(url, { headers: DISCOGS_HEADERS });
      const data = await resp.json();
      return {
        resultados: (data.results || []).map(formatearResultadoDiscogs),
        total:      data.pagination?.items || 0,
        paginas:    data.pagination?.pages || 1,
        pagina,
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error(`GET /genero/${req.params.genero}:`, err.message);
    res.status(500).json({ error: 'Error al obtener discos por género.' });
  }
});


// ══════════════════════════════════════════════════════════
//  DISCO — detalle, historia, video, recomendaciones
// ══════════════════════════════════════════════════════════

// GET /disco/:id
app.get('/disco/:id', async (req, res) => {
  const { id } = req.params;
  const clave  = `disco:${id}`;

  try {
    const resultado = await cachear(clave, TTL.DISCO, async () => {
      const resp = await fetch(
        `https://api.discogs.com/releases/${id}`,
        { headers: DISCOGS_HEADERS }
      );
      if (!resp.ok) return null;

      const data    = await resp.json();
      const artistas = (data.artists || []).map(a => limpiarArtista(a.name));
      const anio     = data.year || null;

      const stats = await obtenerStats(String(data.id));

      return {
        discogs_id: String(data.id),
        titulo:     data.title,
        artista:    artistas.join(', ') || null,
        anio,
        genero:     data.genres?.[0]  || null,
        estilo:     data.styles?.[0]  || null,
        imagen_url: data.images?.[0]?.uri || null,
        tracklist:  (data.tracklist || []).map(t => ({
          posicion: t.position,
          titulo:   t.title,
          duracion: t.duration,
        })),
        precio: calcularPrecio(anio, stats.have, stats.want),
        have:   stats.have,
        want:   stats.want,
        sello:  data.labels?.[0]?.name || null,
        pais:   data.country || null,
      };
    });

    if (!resultado)
      return res.status(404).json({ error: 'Disco no encontrado en Discogs.' });

    res.json(resultado);
  } catch (err) {
    console.error(`GET /disco/${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Error al obtener el disco.' });
  }
});


// GET /disco/:id/historia
app.get('/disco/:id/historia', async (req, res) => {
  const { id } = req.params;
  const clave  = `historia:${id}`;

  try {
    // Intentar obtener título y artista del caché del disco
    let disco = null;
    try {
      const cached = await redis.get(`disco:${id}`);
      if (cached) disco = JSON.parse(cached);
    } catch (e) {}

    if (!disco) {
      const resp = await fetch(
        `https://api.discogs.com/releases/${id}`,
        { headers: DISCOGS_HEADERS }
      );
      if (!resp.ok) return res.status(404).json({ error: 'Disco no encontrado.' });
      const data = await resp.json();
      disco = {
        titulo:  data.title,
        artista: (data.artists || []).map(a => limpiarArtista(a.name))[0] || 'Desconocido',
      };
    }

    const resultado = await cachear(clave, TTL.HISTORIA, async () => {
      const buscarHistoria = async (lang) => {
        const lfResp = await fetch(
          `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(disco.artista)}&album=${encodeURIComponent(disco.titulo)}&format=json&lang=${lang}`
        );
        const lfData = await lfResp.json();
        let cuerpo = lfData.album?.wiki?.content || null;
        if (cuerpo) {
          cuerpo = cuerpo
            .replace(/<a[^>]*>.*?<\/a>/gs, '')
            .replace(/<[^>]+>/g, '')
            .trim();
          if (cuerpo.length < 50) cuerpo = null;
        }
        return cuerpo;
      };

      // Intentar español primero, luego inglés
      let cuerpo = await buscarHistoria('es');
      if (!cuerpo) cuerpo = await buscarHistoria('en');

      return cuerpo ? { cuerpo } : null;
    });

    if (!resultado)
      return res.status(404).json({ error: 'No hay historia disponible para este disco.' });

    res.json(resultado);
  } catch (err) {
    console.error(`GET /disco/${req.params.id}/historia:`, err.message);
    res.status(500).json({ error: 'Error al obtener la historia.' });
  }
});


// GET /disco/:id/video
app.get('/disco/:id/video', async (req, res) => {
  const { id } = req.params;
  const clave  = `video:${id}`;

  try {
    let disco = null;
    try {
      const cached = await redis.get(`disco:${id}`);
      if (cached) disco = JSON.parse(cached);
    } catch (e) {}

    if (!disco) {
      const resp = await fetch(
        `https://api.discogs.com/releases/${id}`,
        { headers: DISCOGS_HEADERS }
      );
      if (!resp.ok) return res.status(404).json({ error: 'Disco no encontrado.' });
      const data = await resp.json();
      disco = {
        titulo:  data.title,
        artista: (data.artists || []).map(a => limpiarArtista(a.name))[0] || '',
      };
    }

    const resultado = await cachear(clave, TTL.VIDEO, async () => {
      const query  = encodeURIComponent(`${disco.titulo} ${disco.artista} album`);
      const ytResp = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`
      );
      const ytData = await ytResp.json();

      if (ytData.error) {
        console.warn('YouTube error:', ytData.error.message);
        return null;
      }

      const videoId = ytData.items?.[0]?.id?.videoId || null;
      return videoId ? { youtube_id: videoId } : null;
    });

    if (!resultado)
      return res.status(404).json({ error: 'No se encontró video para este disco.' });

    res.json(resultado);
  } catch (err) {
    console.error(`GET /disco/${req.params.id}/video:`, err.message);
    res.status(500).json({ error: 'Error al obtener el video.' });
  }
});


// GET /disco/:id/recomendaciones
app.get('/disco/:id/recomendaciones', async (req, res) => {
  const { id }     = req.params;
  const auth       = req.headers.authorization;
  let   id_usuario = null;

  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      id_usuario = payload.id;
    } catch {}
  }

  const clave = `recomendaciones:${id}:${id_usuario || 'anonimo'}`;

  try {
    const resultado = await cachear(clave, TTL.RECOMENDACIONES, async () => {
      // 1. Obtener datos del disco actual
      let discoActual = null;
      try {
        const cached = await redis.get(`disco:${id}`);
        if (cached) discoActual = JSON.parse(cached);
      } catch {}

      if (!discoActual) {
        const resp = await fetch(
          `https://api.discogs.com/releases/${id}`,
          { headers: DISCOGS_HEADERS }
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        discoActual = {
          titulo:  data.title,
          artista: (data.artists || []).map(a => limpiarArtista(a.name))[0] || '',
          genero:  data.genres?.[0] || null,
          estilo:  data.styles?.[0] || null,
        };
      }

      const puntajes = {};

      // 2. Last.fm — artistas similares
      try {
        const lfResp = await fetch(
          `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(discoActual.artista)}&limit=5&format=json`
        );
        const lfData   = await lfResp.json();
        const similares = (lfData.similarartists?.artist || []).map(a => a.name);

        for (const artista of similares) {
          const dsResp = await fetch(
            `https://api.discogs.com/database/search?artist=${encodeURIComponent(artista)}&type=release&per_page=3&page=1`,
            { headers: DISCOGS_HEADERS }
          );
          const dsData = await dsResp.json();
          for (const item of (dsData.results || [])) {
            const key = String(item.id);
            if (key === id) continue;
            if (!puntajes[key]) puntajes[key] = { datos: formatearResultadoDiscogs(item), peso: 0 };
            puntajes[key].peso += 1;
          }
        }
      } catch (e) {
        console.warn('Last.fm similar artists error:', e.message);
      }

      // 3. Discogs — mismo género y estilo
      try {
        if (discoActual.genero) {
          const dsResp = await fetch(
            `https://api.discogs.com/database/search?genre=${encodeURIComponent(discoActual.genero)}&style=${encodeURIComponent(discoActual.estilo || '')}&type=release&per_page=5&page=1&sort=have&sort_order=desc`,
            { headers: DISCOGS_HEADERS }
          );
          const dsData = await dsResp.json();
          for (const item of (dsData.results || [])) {
            const key = String(item.id);
            if (key === id) continue;
            if (!puntajes[key]) puntajes[key] = { datos: formatearResultadoDiscogs(item), peso: 0 };
            puntajes[key].peso += 1;
          }
        }
      } catch (e) {
        console.warn('Discogs genre search error:', e.message);
      }

      // 4. Historial del usuario — boost a géneros que ya vio
      if (id_usuario) {
        try {
          const historial = await prisma.historial_usuario.findMany({
            where:   { id_usuario },
            orderBy: { visto_en: 'desc' },
            take:    20,
          });
          const generosVistos = historial.map(h => h.genero).filter(Boolean);

          for (const key of Object.keys(puntajes)) {
            const generoItem = puntajes[key].datos.genero;
            if (generoItem && generosVistos.includes(generoItem)) {
              puntajes[key].peso += 1;
            }
          }
        } catch (e) {
          console.warn('Historial query error:', e.message);
        }
      }

      return Object.values(puntajes)
        .sort((a, b) => b.peso - a.peso)
        .slice(0, 5)
        .map(r => r.datos);
    });

    res.json(resultado);
  } catch (err) {
    console.error(`GET /disco/${req.params.id}/recomendaciones:`, err.message);
    res.status(500).json({ error: 'Error al obtener recomendaciones.' });
  }
});


// ══════════════════════════════════════════════════════════
//  HISTORIAL — /historial
// ══════════════════════════════════════════════════════════

app.post('/historial', verificarToken, async (req, res) => {
  const { discogs_id, titulo, artista, genero, estilo } = req.body;
  const id_usuario = req.usuario.id;

  if (!discogs_id || !titulo || !artista)
    return res.status(400).json({ error: 'discogs_id, titulo y artista son requeridos.' });

  try {
    await prisma.historial_usuario.create({
      data: {
        id_usuario,
        discogs_id: String(discogs_id),
        titulo,
        artista,
        genero: genero || null,
        estilo: estilo || null,
      },
    });
    res.status(201).json({ mensaje: 'Historial actualizado.' });
  } catch (err) {
    console.error('POST /historial:', err.message);
    res.status(500).json({ error: 'Error al guardar en el historial.' });
  }
});

app.get('/historial', verificarToken, async (req, res) => {
  try {
    const historial = await prisma.historial_usuario.findMany({
      where:   { id_usuario: req.usuario.id },
      orderBy: { visto_en: 'desc' },
      take:    50,
    });
    res.json(historial);
  } catch (err) {
    console.error('GET /historial:', err.message);
    res.status(500).json({ error: 'Error al obtener el historial.' });
  }
});


// ══════════════════════════════════════════════════════════
//  CHECKOUT — /checkout
// ══════════════════════════════════════════════════════════

app.post('/checkout', verificarToken, async (req, res) => {
  const { items, envio } = req.body;
  const id_cliente = req.usuario.id;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'El carrito está vacío.' });

  for (const item of items) {
    if (!item.discogs_id || !item.titulo || !item.artista)
      return res.status(400).json({ error: 'Cada ítem debe tener discogs_id, titulo y artista.' });
    if (!Number.isInteger(item.cantidad) || item.cantidad < 1)
      return res.status(400).json({ error: 'La cantidad debe ser un entero positivo.' });
    if (typeof item.precio !== 'number' || item.precio < 0)
      return res.status(400).json({ error: 'El precio debe ser un número positivo.' });
  }

  if (!envio?.nombre_receptor || !envio?.calle || !envio?.numero_ext ||
      !envio?.colonia || !envio?.ciudad || !envio?.estado || !envio?.codigo_postal)
    return res.status(400).json({ error: 'Los datos de envío son requeridos.' });

  try {
    const total = items.reduce((sum, item) => sum + item.precio * item.cantidad, 0);

    const venta = await prisma.venta.create({
      data: {
        id_cliente,
        total,
        estado: 'pagada',
        lineas: {
          create: items.map(item => ({
            discogs_id: String(item.discogs_id),
            titulo:     item.titulo,
            artista:    item.artista,
            cantidad:   item.cantidad,
            p_unitario: item.precio,
            subtotal:   item.precio * item.cantidad,
          })),
        },
        envio: {
          create: {
            nombre_receptor: envio.nombre_receptor.trim(),
            calle:           envio.calle.trim(),
            numero_ext:      envio.numero_ext.trim(),
            numero_int:      envio.numero_int?.trim() || null,
            colonia:         envio.colonia.trim(),
            ciudad:          envio.ciudad.trim(),
            estado:          envio.estado.trim(),
            codigo_postal:   envio.codigo_postal.trim(),
            referencias:     envio.referencias?.trim() || null,
          },
        },
      },
    });

    res.status(201).json({
      mensaje:  '¡Compra procesada exitosamente!',
      id_venta: venta.id_venta,
      total:    total.toFixed(2),
    });
  } catch (err) {
    console.error('POST /checkout:', err.message);
    res.status(500).json({ error: 'Error al procesar la compra.' });
  }
});




// ══════════════════════════════════════════════════════════
//  MIS COMPRAS — /mis-compras
// ══════════════════════════════════════════════════════════

// GET /mis-compras — historial de compras del usuario logueado
app.get('/mis-compras', verificarToken, async (req, res) => {
  try {
    const ventas = await prisma.venta.findMany({
      where:   { id_cliente: req.usuario.id },
      orderBy: { fecha: 'desc' },
      include: {
        lineas: true,
        envio:  { select: { ciudad: true, estado: true } },
      },
    });

    const resultado = ventas.map(v => ({
      id_venta: v.id_venta,
      total:    Number(v.total),
      estado:   v.estado,
      fecha:    v.fecha,
      ciudad:   v.envio?.ciudad || null,
      discos:   v.lineas.map(l => ({
        discogs_id: l.discogs_id,
        titulo:     l.titulo,
        artista:    l.artista,
        cantidad:   l.cantidad,
        precio:     Number(l.p_unitario),
        subtotal:   Number(l.subtotal),
      })),
    }));

    res.json(resultado);
  } catch (err) {
    console.error('GET /mis-compras:', err.message);
    res.status(500).json({ error: 'Error al obtener el historial de compras.' });
  }
});

// ══════════════════════════════════════════════════════════
//  DIAGNÓSTICO — /redis-ping
// ══════════════════════════════════════════════════════════

// GET /redis-ping — verifica Redis y muestra claves en caché (solo admin)
app.get('/redis-ping', verificarToken, soloAdmin, async (req, res) => {
  try {
    const pong = await redis.ping();
    const keys = await redis.keys('*');
    res.json({
      estado:        pong === 'PONG' ? 'conectado' : 'error',
      keys_en_cache: keys.length,
      keys:          keys.sort(),
    });
  } catch (err) {
    res.status(500).json({ estado: 'error', mensaje: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  ADMIN — /admin/usuarios  /admin/ventas
// ══════════════════════════════════════════════════════════

// GET /admin/usuarios — lista todos los usuarios
app.get('/admin/usuarios', verificarToken, soloAdmin, async (req, res) => {
  try {
    const usuarios = await prisma.usuario.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id_usuario: true,
        nombre:     true,
        correo:     true,
        rol:        true,
        created_at: true,
      },
    });
    res.json(usuarios);
  } catch (err) {
    console.error('GET /admin/usuarios:', err.message);
    res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
});

// PUT /admin/usuarios/:id/rol — cambiar rol de un usuario
app.put('/admin/usuarios/:id/rol', verificarToken, soloAdmin, async (req, res) => {
  const id  = parseInt(req.params.id);
  const { rol } = req.body;

  if (!['cliente', 'vendedor', 'admin'].includes(rol))
    return res.status(400).json({ error: 'Rol inválido.' });

  try {
    await prisma.usuario.update({
      where: { id_usuario: id },
      data:  { rol },
    });
    res.json({ mensaje: `Rol actualizado a "${rol}".` });
  } catch (err) {
    console.error('PUT /admin/usuarios/:id/rol:', err.message);
    res.status(500).json({ error: 'Error al actualizar el rol.' });
  }
});

// DELETE /admin/usuarios/:id — eliminar un usuario
app.delete('/admin/usuarios/:id', verificarToken, soloAdmin, async (req, res) => {
  const id = parseInt(req.params.id);

  if (id === req.usuario.id)
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo.' });

  try {
    await prisma.usuario.delete({ where: { id_usuario: id } });
    res.json({ mensaje: 'Usuario eliminado.' });
  } catch (err) {
    console.error('DELETE /admin/usuarios/:id:', err.message);
    res.status(500).json({ error: 'Error al eliminar el usuario.' });
  }
});

// GET /admin/ventas — lista todas las ventas
app.get('/admin/ventas', verificarToken, soloAdmin, async (req, res) => {
  try {
    const ventas = await prisma.venta.findMany({
      orderBy: { fecha: 'desc' },
      include: {
        cliente: {
          select: { id_usuario: true, nombre: true },
        },
      },
    });
    res.json(ventas);
  } catch (err) {
    console.error('GET /admin/ventas:', err.message);
    res.status(500).json({ error: 'Error al obtener ventas.' });
  }
});

// GET /admin/ventas/:id — detalle de una venta
app.get('/admin/ventas/:id', verificarToken, soloAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const venta = await prisma.venta.findUnique({
      where:   { id_venta: id },
      include: {
        cliente: { select: { id_usuario: true, nombre: true } },
        lineas:  true,
        envio:   true,
      },
    });
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });
    res.json(venta);
  } catch (err) {
    console.error('GET /admin/ventas/:id:', err.message);
    res.status(500).json({ error: 'Error al obtener la venta.' });
  }
});

// PUT /admin/ventas/:id/estado — cambiar estado de una venta
app.put('/admin/ventas/:id/estado', verificarToken, soloAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { estado } = req.body;

  const estadosValidos = ['pendiente', 'pagada', 'enviada', 'entregada', 'cancelada'];
  if (!estadosValidos.includes(estado))
    return res.status(400).json({ error: 'Estado inválido.' });

  try {
    await prisma.venta.update({
      where: { id_venta: id },
      data:  { estado },
    });
    res.json({ mensaje: `Estado actualizado a "${estado}".` });
  } catch (err) {
    console.error('PUT /admin/ventas/:id/estado:', err.message);
    res.status(500).json({ error: 'Error al actualizar el estado.' });
  }
});

// ══════════════════════════════════════════════════════════
//  INICIO DEL SERVIDOR
// ══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('Conexion a PostgreSQL exitosa (Prisma).');
  } catch (err) {
    console.error('ERROR DE CONEXION A DB:', err.message);
  }
  try {
    await redis.ping();
    console.log('Conexion a Redis exitosa.');
  } catch (err) {
    console.error('ERROR DE CONEXION A REDIS:', err.message);
  }
});
