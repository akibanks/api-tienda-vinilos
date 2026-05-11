// ══════════════════════════════════════════════════════════
//  VinylVibes — index.js  (backend v2)
//
//  Cambios respecto a v1:
//    · JWT reemplaza el chequeo de admin por nombre en el body.
//    · soloAdmin usa el payload del token, no una query a la BD.
//    · /checkout crea venta + linea_venta en una sola transacción
//      atómica con SELECT … FOR UPDATE (sin condiciones de carrera).
//    · /discos/:id/compra también registra venta/linea_venta y usa JWT.
//    · Stock se descuenta vía triggers de la BD (trg_restar_stock).
//    · CORS configurable por variable de entorno CORS_ORIGIN.
//    · Validación de inputs más estricta en todos los endpoints.
//
//  Variables de entorno requeridas (.env):
//    DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT
//    JWT_SECRET        — clave secreta para firmar tokens (¡cambiar en producción!)
//    CORS_ORIGIN       — lista separada por comas de orígenes permitidos
//                        (ej: https://tuusuario.github.io,https://vinylvibes.com)
//                        Si está vacía, acepta cualquier origen (útil en desarrollo).
//    PORT              — puerto del servidor (default 3000)
//
//  Dependencias nuevas: npm install jsonwebtoken
// ══════════════════════════════════════════════════════════

require('dotenv').config();
const cors    = require('cors');
const express = require('express');
const { Pool } = require('pg');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_cambiar_en_produccion';
const JWT_EXPIRY = '7d';

const app  = express();
const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT,
  ssl:      { rejectUnauthorized: false },
});


// ── MIDDLEWARES ───────────────────────────────────────────

// CORS: restringe orígenes mediante CORS_ORIGIN; sin configurar acepta todo
// (conveniente para desarrollo local y Render previews).
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Peticiones sin origen (curl, Postman, mismo origen) siempre pasan.
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`Origen no permitido por CORS: ${origin}`));
    }
  },
  credentials: true,
}));

app.use(express.json());


// ── MIDDLEWARES DE AUTH ───────────────────────────────────

/**
 * Extrae y verifica el JWT del header Authorization: Bearer <token>.
 * Si el token es válido, adjunta req.usuario = { id, nombre, rol }.
 */
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

/**
 * Requiere que el usuario autenticado tenga rol 'admin'.
 * Usar siempre DESPUÉS de verificarToken.
 */
function soloAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin')
    return res.status(403).json({ error: 'Acceso denegado: se requieren permisos de administrador.' });
  next();
}


// ── HELPERS ───────────────────────────────────────────────

/**
 * Dado un nombre de artista, devuelve su id_artista existente o
 * lo crea en la misma transacción del cliente recibido.
 */
async function obtenerOCrearArtista(client, nombre) {
  const limpio = nombre.trim();
  const existe = await client.query(
    'SELECT id_artista FROM artista WHERE nombre = $1',
    [limpio]
  );
  if (existe.rows.length > 0) return existe.rows[0].id_artista;
  const nuevo = await client.query(
    'INSERT INTO artista (nombre) VALUES ($1) RETURNING id_artista',
    [limpio]
  );
  return nuevo.rows[0].id_artista;
}

/**
 * Normaliza una fila de producto al shape que espera el frontend.
 */
function formatearDisco(row) {
  return {
    id:         row.id_producto,
    titulo:     row.titulo,
    artista:    row.artista   ?? null,
    precio:     row.precio,
    anio:       row.anio,
    stock:      row.stock,
    imagen_url: row.url_img   ?? null,
    video_url:  row.video_url ?? null,
    genero:     row.genero    ?? null,
  };
}

/** Query base reutilizable: producto + artista agregado + video principal. */
const SQL_DISCOS = `
  SELECT
    p.id_producto,
    p.titulo,
    p.precio,
    p.anio,
    p.stock,
    p.url_img,
    p.genero,
    STRING_AGG(DISTINCT a.nombre, ', ' ORDER BY a.nombre) AS artista,
    pv.youtube_id AS video_url
  FROM producto p
  LEFT JOIN producto_artista pa ON p.id_producto = pa.id_producto
  LEFT JOIN artista           a  ON pa.id_artista = a.id_artista
  LEFT JOIN producto_video    pv ON p.id_producto = pv.id_producto
                                 AND pv.tipo = 'principal'
`;


// ══════════════════════════════════════════════════════════
//  AUTH — /registro
// ══════════════════════════════════════════════════════════

app.post('/registro', async (req, res) => {
  const { nombre_usuario, password } = req.body;

  if (!nombre_usuario?.trim() || !password)
    return res.status(400).json({ error: 'Nombre de usuario y contraseña son requeridos.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

  try {
    const existe = await pool.query(
      'SELECT id_usuario FROM usuario WHERE nombre = $1',
      [nombre_usuario.trim()]
    );
    if (existe.rows.length > 0)
      return res.status(409).json({ error: 'El nombre de usuario ya está en uso.' });

    const hash             = await bcrypt.hash(password, 10);
    const correoPlaceholder = `${nombre_usuario.trim()}@vinylvibes.local`;

    await pool.query(
      `INSERT INTO usuario (nombre, correo, contrasena, rol) VALUES ($1, $2, $3, 'cliente')`,
      [nombre_usuario.trim(), correoPlaceholder, hash]
    );
    res.status(201).json({ mensaje: 'Usuario creado exitosamente.' });
  } catch (err) {
    console.error('REGISTRO:', err.message);
    res.status(500).json({ error: 'Error al crear la cuenta.' });
  }
});


// ══════════════════════════════════════════════════════════
//  AUTH — /login
// ══════════════════════════════════════════════════════════

app.post('/login', async (req, res) => {
  const { nombre_usuario, password } = req.body;

  if (!nombre_usuario?.trim() || !password)
    return res.status(400).json({ error: 'Nombre y contraseña son requeridos.' });

  try {
    const r = await pool.query(
      'SELECT * FROM usuario WHERE nombre = $1',
      [nombre_usuario.trim()]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Usuario no encontrado.' });

    const usuario    = r.rows[0];
    const esCorrecta = await bcrypt.compare(password, usuario.contrasena);
    if (!esCorrecta)
      return res.status(401).json({ error: 'Contraseña incorrecta.' });

    // Emitir JWT con id, nombre y rol — nunca incluir la contraseña
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
//  DISCOS — CRUD
// ══════════════════════════════════════════════════════════

// GET /discos — catálogo completo
app.get('/discos', async (req, res) => {
  try {
    const r = await pool.query(
      SQL_DISCOS + ' GROUP BY p.id_producto, pv.youtube_id ORDER BY p.id_producto ASC'
    );
    res.json(r.rows.map(formatearDisco));
  } catch (err) {
    console.error('GET /discos:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los discos.' });
  }
});

// GET /discos/:id — un disco por id
app.get('/discos/:id', async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  try {
    const r = await pool.query(
      SQL_DISCOS + ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Disco no encontrado.' });
    res.json(formatearDisco(r.rows[0]));
  } catch (err) {
    console.error('GET /discos/:id:', err.message);
    res.status(500).json({ error: 'Error al obtener el disco.' });
  }
});

// POST /discos — crear disco (solo admin)
app.post('/discos', verificarToken, soloAdmin, async (req, res) => {
  const { titulo, artista, precio, anio, stock, imagen_url, video_url, genero } = req.body;

  if (!titulo?.trim())
    return res.status(400).json({ error: 'El título es obligatorio.' });
  if (typeof precio !== 'number' || precio < 0)
    return res.status(400).json({ error: 'El precio debe ser un número positivo.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rProd = await client.query(
      `INSERT INTO producto (titulo, precio, anio, stock, url_img, genero)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_producto`,
      [
        titulo.trim(),
        precio,
        anio ?? new Date().getFullYear(),
        stock ?? 0,
        imagen_url?.trim() || null,
        genero?.trim()     || null,
      ]
    );
    const id_producto = rProd.rows[0].id_producto;

    if (artista?.trim()) {
      const id_artista = await obtenerOCrearArtista(client, artista);
      await client.query(
        'INSERT INTO producto_artista (id_producto, id_artista) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id_producto, id_artista]
      );
    }

    if (video_url?.trim()) {
      await client.query(
        `INSERT INTO producto_video (id_producto, youtube_id, tipo) VALUES ($1, $2, 'principal')`,
        [id_producto, video_url.trim()]
      );
    }

    await client.query('COMMIT');

    const rFinal = await pool.query(
      SQL_DISCOS + ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id_producto]
    );
    res.status(201).json(formatearDisco(rFinal.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /discos:', err.message);
    res.status(500).json({ error: 'Error al guardar en la base de datos.' });
  } finally {
    client.release();
  }
});

// PUT /discos/:id — editar disco (solo admin)
app.put('/discos/:id', verificarToken, soloAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const { titulo, artista, precio, anio, stock, imagen_url, video_url, genero } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rProd = await client.query(
      `UPDATE producto
       SET titulo  = $1, precio = $2, anio = $3, stock = $4, url_img = $5, genero = $6
       WHERE id_producto = $7
       RETURNING id_producto`,
      [titulo, precio, anio, stock, imagen_url?.trim() || null, genero?.trim() || null, id]
    );
    if (rProd.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Disco no encontrado.' });
    }

    if (artista !== undefined) {
      await client.query('DELETE FROM producto_artista WHERE id_producto = $1', [id]);
      if (artista?.trim()) {
        const id_artista = await obtenerOCrearArtista(client, artista);
        await client.query(
          'INSERT INTO producto_artista (id_producto, id_artista) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, id_artista]
        );
      }
    }

    if (video_url !== undefined) {
      if (video_url?.trim()) {
        await client.query(
          `INSERT INTO producto_video (id_producto, youtube_id, tipo) VALUES ($1, $2, 'principal')
           ON CONFLICT (id_producto, tipo) DO UPDATE SET youtube_id = EXCLUDED.youtube_id`,
          [id, video_url.trim()]
        );
      } else {
        await client.query(
          "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
          [id]
        );
      }
    }

    await client.query('COMMIT');

    const rFinal = await pool.query(
      SQL_DISCOS + ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id]
    );
    res.json(formatearDisco(rFinal.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /discos/:id:', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

// DELETE /discos/:id — borrar disco (solo admin, cascada automática en BD)
app.delete('/discos/:id', verificarToken, soloAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  try {
    const r = await pool.query(
      'DELETE FROM producto WHERE id_producto = $1 RETURNING id_producto',
      [id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Disco no encontrado.' });
    res.json({ mensaje: 'Disco eliminado correctamente.' });
  } catch (err) {
    // Código 23503 = foreign_key_violation en PostgreSQL
    // Significa que el disco tiene ventas registradas y no se puede borrar
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'Este disco tiene ventas registradas y no puede eliminarse para conservar el historial contable. Puedes poner su stock en 0 para que no aparezca disponible.',
      });
    }
    console.error('DELETE /discos/:id:', err.message);
    res.status(500).json({ error: 'Error al eliminar el disco.' });
  }
});


// ══════════════════════════════════════════════════════════
//  CHECKOUT — /checkout
//
//  Reemplaza el loop de peticiones individuales a /compra.
//  Recibe todos los ítems del carrito en una sola petición,
//  verifica stock con FOR UPDATE (evita condiciones de carrera),
//  crea la venta y sus líneas en una transacción atómica.
//  El trigger trg_restar_stock descuenta el stock automáticamente
//  al insertar cada linea_venta.
//
//  Body: { items: [{ id_producto: number, cantidad: number }] }
// ══════════════════════════════════════════════════════════

app.post('/checkout', verificarToken, async (req, res) => {
  const { items } = req.body;
  const id_cliente = req.usuario.id;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'El carrito está vacío.' });

  // Validar estructura básica de cada ítem
  for (const item of items) {
    if (!Number.isInteger(item.id_producto) || !Number.isInteger(item.cantidad) || item.cantidad < 1)
      return res.status(400).json({ error: 'Formato de artículos inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bloquear filas de producto para evitar overselling concurrente
    const ids     = items.map(i => i.id_producto);
    const rStock  = await client.query(
      'SELECT id_producto, titulo, stock, precio FROM producto WHERE id_producto = ANY($1) FOR UPDATE',
      [ids]
    );

    const productoMap = Object.fromEntries(
      rStock.rows.map(r => [r.id_producto, r])
    );

    // Verificar que todos los productos existen y tienen stock suficiente
    const errores = [];
    for (const item of items) {
      const prod = productoMap[item.id_producto];
      if (!prod) {
        errores.push(`Producto ${item.id_producto} no encontrado.`);
        continue;
      }
      if (prod.stock < item.cantidad) {
        errores.push(
          `"${prod.titulo}" solo tiene ${prod.stock} unidad(es) disponible(s) y pediste ${item.cantidad}.`
        );
      }
    }

    if (errores.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: errores.join(' | ') });
    }

    // Calcular total
    const total = items.reduce((sum, item) => {
      return sum + Number(productoMap[item.id_producto].precio) * item.cantidad;
    }, 0);

    // Crear la venta
    const rVenta = await client.query(
      `INSERT INTO venta (id_cliente, total, estado) VALUES ($1, $2, 'pagada') RETURNING id_venta`,
      [id_cliente, total.toFixed(2)]
    );
    const id_venta = rVenta.rows[0].id_venta;

    // Insertar líneas — trg_restar_stock descuenta el stock automáticamente
    for (const item of items) {
      const prod     = productoMap[item.id_producto];
      const subtotal = Number(prod.precio) * item.cantidad;
      await client.query(
        `INSERT INTO linea_venta (id_venta, id_producto, cantidad, p_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [id_venta, item.id_producto, item.cantidad, prod.precio, subtotal.toFixed(2)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      mensaje: '¡Compra procesada exitosamente!',
      id_venta,
      total: total.toFixed(2),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /checkout:', err.message);
    res.status(500).json({ error: 'Error al procesar la compra.' });
  } finally {
    client.release();
  }
});

// POST /discos/:id/compra — compra individual (modo legacy, ahora con JWT y registro de venta)
app.post('/discos/:id/compra', verificarToken, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const id_cliente = req.usuario.id;
  const client     = await pool.connect();

  try {
    await client.query('BEGIN');

    const rProd = await client.query(
      'SELECT id_producto, titulo, precio, stock FROM producto WHERE id_producto = $1 FOR UPDATE',
      [id]
    );
    if (rProd.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Disco no encontrado.' });
    }

    const prod = rProd.rows[0];
    if (prod.stock < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No hay stock disponible.' });
    }

    // Crear venta + línea; el trigger descuenta el stock
    const rVenta = await client.query(
      `INSERT INTO venta (id_cliente, total, estado) VALUES ($1, $2, 'pagada') RETURNING id_venta`,
      [id_cliente, prod.precio]
    );
    await client.query(
      `INSERT INTO linea_venta (id_venta, id_producto, cantidad, p_unitario, subtotal)
       VALUES ($1, $2, 1, $3, $3)`,
      [rVenta.rows[0].id_venta, id, prod.precio]
    );

    await client.query('COMMIT');

    const rFinal = await pool.query(
      'SELECT stock FROM producto WHERE id_producto = $1', [id]
    );
    res.json({ mensaje: 'Compra procesada.', nuevoStock: rFinal.rows[0].stock });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /compra:', err.message);
    res.status(500).json({ error: 'Error al procesar la compra.' });
  } finally {
    client.release();
  }
});


// ══════════════════════════════════════════════════════════
//  HISTORIA — /discos/:id/historia
// ══════════════════════════════════════════════════════════

// GET — obtener historia de un disco (público)
app.get('/discos/:id/historia', async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  try {
    const r = await pool.query(
      'SELECT * FROM producto_historia WHERE id_producto = $1',
      [id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Este disco aún no tiene historia.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /historia:', err.message);
    res.status(500).json({ error: 'Error al obtener la historia.' });
  }
});

// PUT — crear o actualizar historia (solo admin)
app.put('/discos/:id/historia', verificarToken, soloAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const { resumen, cuerpo, autor_editorial } = req.body;

  try {
    const r = await pool.query(
      `INSERT INTO producto_historia (id_producto, resumen, cuerpo, autor_editorial)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_producto) DO UPDATE
         SET resumen         = EXCLUDED.resumen,
             cuerpo          = EXCLUDED.cuerpo,
             autor_editorial = EXCLUDED.autor_editorial
       RETURNING *`,
      [id, resumen ?? null, cuerpo ?? null, autor_editorial ?? null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /historia:', err.message);
    res.status(500).json({ error: 'Error al guardar la historia.' });
  }
});


// ══════════════════════════════════════════════════════════
//  VIDEO — /discos/:id/video
// ══════════════════════════════════════════════════════════

// PUT — asignar o cambiar el video principal (solo admin)
app.put('/discos/:id/video', verificarToken, soloAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const { youtube_id, descripcion } = req.body;

  try {
    if (!youtube_id?.trim()) {
      await pool.query(
        "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
        [id]
      );
      return res.json({ mensaje: 'Video eliminado.' });
    }

    const r = await pool.query(
      `INSERT INTO producto_video (id_producto, youtube_id, tipo, descripcion)
       VALUES ($1, $2, 'principal', $3)
       ON CONFLICT (id_producto, tipo) DO UPDATE
         SET youtube_id  = EXCLUDED.youtube_id,
             descripcion = EXCLUDED.descripcion
       RETURNING *`,
      [id, youtube_id.trim(), descripcion ?? null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /video:', err.message);
    res.status(500).json({ error: 'Error al guardar el video.' });
  }
});

// DELETE — eliminar video principal (solo admin)
app.delete('/discos/:id/video', verificarToken, soloAdmin, async (req, res) => {
  const { id } = req.params;
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  try {
    await pool.query(
      "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
      [id]
    );
    res.json({ mensaje: 'Video eliminado.' });
  } catch (err) {
    console.error('DELETE /video:', err.message);
    res.status(500).json({ error: 'Error al eliminar el video.' });
  }
});


// ── INICIO DEL SERVIDOR ───────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  pool.query('SELECT NOW()', (err) => {
    if (err) console.error('ERROR DE CONEXIÓN A DB:', err.message);
    else     console.log('Conexión a PostgreSQL exitosa.');
  });
});
