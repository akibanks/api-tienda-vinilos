require('dotenv').config();
const cors    = require('cors');
const express = require('express');
const { Pool } = require('pg');
const bcrypt  = require('bcrypt');

const app  = express();
const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT,
  ssl:      { rejectUnauthorized: false }
});

// ── MIDDLEWARES ───────────────────────────────────────────
app.use(cors());
app.use(express.json());


// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Verifica que el nombre_usuario enviado en el body pertenezca
 * a un usuario con rol 'admin'. Devuelve true/false.
 */
async function esAdmin(nombre_usuario) {
  if (!nombre_usuario) return false;
  const r = await pool.query(
    "SELECT rol FROM usuario WHERE nombre = $1",
    [nombre_usuario]
  );
  return r.rows[0]?.rol === 'admin';
}

/**
 * Dado un nombre de artista (string), devuelve su id_artista.
 * Si no existe lo crea. Usado en POST y PUT de discos.
 */
async function obtenerOCrearArtista(client, nombre) {
  const nombre_limpio = nombre.trim();
  const existe = await client.query(
    'SELECT id_artista FROM artista WHERE nombre = $1',
    [nombre_limpio]
  );
  if (existe.rows.length > 0) return existe.rows[0].id_artista;

  const nuevo = await client.query(
    'INSERT INTO artista (nombre) VALUES ($1) RETURNING id_artista',
    [nombre_limpio]
  );
  return nuevo.rows[0].id_artista;
}

/**
 * Formatea una fila de producto para que el frontend reciba
 * los mismos nombres de campo que antes (imagen_url, video_url, etc.)
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

/**
 * Query reutilizable que trae todos los campos necesarios de un disco,
 * incluyendo el artista (agregado) y el video principal.
 */
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
    pv.youtube_id                                          AS video_url
  FROM producto p
  LEFT JOIN producto_artista pa ON p.id_producto = pa.id_producto
  LEFT JOIN artista           a  ON pa.id_artista = a.id_artista
  LEFT JOIN producto_video    pv ON p.id_producto = pv.id_producto
                                 AND pv.tipo = 'principal'
`;


// ══════════════════════════════════════════════════════════
//  AUTH — /login
// ══════════════════════════════════════════════════════════

app.post('/login', async (req, res) => {
  const { nombre_usuario, password } = req.body;
  try {
    const r = await pool.query(
      'SELECT * FROM usuario WHERE nombre = $1',
      [nombre_usuario]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Usuario no encontrado' });

    const usuario    = r.rows[0];
    const esCorrecta = await bcrypt.compare(password, usuario.contrasena);

    if (!esCorrecta)
      return res.status(401).json({ error: 'Contraseña incorrecta' });

    res.json({
      nombre:   usuario.nombre,
      es_admin: usuario.rol === 'admin',   // mantiene compatibilidad con el frontend
    });
  } catch (err) {
    console.error('LOGIN:', err.message);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});


// ══════════════════════════════════════════════════════════
//  DISCOS — CRUD
// ══════════════════════════════════════════════════════════

// GET /discos — devuelve todos los productos con artista y video
app.get('/discos', async (req, res) => {
  try {
    const r = await pool.query(
      SQL_DISCOS + ' GROUP BY p.id_producto, pv.youtube_id ORDER BY p.id_producto ASC'
    );
    res.json(r.rows.map(formatearDisco));
  } catch (err) {
    console.error('GET /discos:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los discos' });
  }
});

// GET /discos/:id — devuelve un disco por id
app.get('/discos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await pool.query(
      SQL_DISCOS +
      ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Disco no encontrado' });

    res.json(formatearDisco(r.rows[0]));
  } catch (err) {
    console.error('GET /discos/:id:', err.message);
    res.status(500).json({ error: 'Error al obtener el disco' });
  }
});

// POST /discos — crea un nuevo disco (solo admin)
app.post('/discos', async (req, res) => {
  const { titulo, artista, precio, anio, stock, imagen_url, video_url, genero, nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'Acceso denegado: no tienes permisos de administrador.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insertar producto
    const rProd = await client.query(
      `INSERT INTO producto (titulo, precio, anio, stock, url_img, genero)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_producto`,
      [titulo, precio, anio ?? new Date().getFullYear(), stock ?? 0, imagen_url ?? null, genero ?? null]
    );
    const id_producto = rProd.rows[0].id_producto;

    // 2. Artista → buscar o crear + vincular
    if (artista) {
      const id_artista = await obtenerOCrearArtista(client, artista);
      await client.query(
        'INSERT INTO producto_artista (id_producto, id_artista) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id_producto, id_artista]
      );
    }

    // 3. Video principal (opcional)
    if (video_url) {
      await client.query(
        `INSERT INTO producto_video (id_producto, youtube_id, tipo)
         VALUES ($1, $2, 'principal')`,
        [id_producto, video_url]
      );
    }

    await client.query('COMMIT');

    // 4. Devolver el disco completo
    const rFinal = await pool.query(
      SQL_DISCOS +
      ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id_producto]
    );
    res.status(201).json(formatearDisco(rFinal.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /discos:', err.message);
    res.status(500).json({ error: 'Error al guardar en la base de datos' });
  } finally {
    client.release();
  }
});

// PUT /discos/:id — actualiza un disco (solo admin)
app.put('/discos/:id', async (req, res) => {
  const { id } = req.params;
  const { titulo, artista, precio, anio, stock, imagen_url, video_url, genero, nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'No tienes permiso.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Actualizar producto
    const rProd = await client.query(
      `UPDATE producto
       SET titulo   = $1,
           precio   = $2,
           anio     = $3,
           stock    = $4,
           url_img  = $5,
           genero   = $6
       WHERE id_producto = $7
       RETURNING id_producto`,
      [titulo, precio, anio, stock, imagen_url ?? null, genero ?? null, id]
    );
    if (rProd.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Disco no encontrado' });
    }

    // 2. Actualizar artista: eliminar vínculos anteriores y volver a vincular
    if (artista !== undefined) {
      await client.query('DELETE FROM producto_artista WHERE id_producto = $1', [id]);
      if (artista) {
        const id_artista = await obtenerOCrearArtista(client, artista);
        await client.query(
          'INSERT INTO producto_artista (id_producto, id_artista) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, id_artista]
        );
      }
    }

    // 3. Actualizar video principal: upsert
    if (video_url !== undefined) {
      if (video_url) {
        await client.query(
          `INSERT INTO producto_video (id_producto, youtube_id, tipo)
           VALUES ($1, $2, 'principal')
           ON CONFLICT (id_producto, tipo) DO UPDATE SET youtube_id = EXCLUDED.youtube_id`,
          [id, video_url]
        );
      } else {
        // Si se manda video_url vacío, se borra el video principal
        await client.query(
          "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
          [id]
        );
      }
    }

    await client.query('COMMIT');

    const rFinal = await pool.query(
      SQL_DISCOS +
      ' WHERE p.id_producto = $1 GROUP BY p.id_producto, pv.youtube_id',
      [id]
    );
    res.json(formatearDisco(rFinal.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /discos/:id:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// DELETE /discos/:id — borra un disco (solo admin, cascada automática)
app.delete('/discos/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'No tienes permiso para borrar discos.' });

  try {
    const r = await pool.query(
      'DELETE FROM producto WHERE id_producto = $1 RETURNING id_producto',
      [id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Disco no encontrado' });

    res.json({ mensaje: 'Disco eliminado correctamente' });
  } catch (err) {
    console.error('DELETE /discos/:id:', err.message);
    res.status(500).json({ error: 'Error al eliminar el disco' });
  }
});


// ══════════════════════════════════════════════════════════
//  COMPRA — /discos/:id/compra
// ══════════════════════════════════════════════════════════
// Descuenta stock directamente en `producto`.
// NOTA: si los triggers de linea_venta están activos en la BD,
// no uses ambos mecanismos a la vez para evitar doble descuento.

app.post('/discos/:id/compra', async (req, res) => {
  const { id } = req.params;
  try {
    // Verifica stock y descuenta en una sola operación atómica
    const r = await pool.query(
      `UPDATE producto
       SET stock = stock - 1
       WHERE id_producto = $1 AND stock > 0
       RETURNING stock AS nuevo_stock`,
      [id]
    );

    if (r.rows.length === 0) {
      // Distingue entre "no existe" y "sin stock"
      const existe = await pool.query(
        'SELECT id_producto FROM producto WHERE id_producto = $1', [id]
      );
      if (existe.rows.length === 0)
        return res.status(404).json({ error: 'Disco no encontrado' });
      return res.status(400).json({ error: 'No hay stock disponible' });
    }

    res.json({ mensaje: 'Compra procesada', nuevoStock: r.rows[0].nuevo_stock });
  } catch (err) {
    console.error('POST /compra:', err.message);
    res.status(500).json({ error: 'Error al procesar la compra' });
  }
});


//  HISTORIA — /discos/:id/historia

// GET — obtener historia de un disco
app.get('/discos/:id/historia', async (req, res) => {
  const { id } = req.params;
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
    res.status(500).json({ error: 'Error al obtener la historia' });
  }
});

// PUT — crear o actualizar historia (solo admin)
app.put('/discos/:id/historia', async (req, res) => {
  const { id } = req.params;
  const { resumen, cuerpo, autor_editorial, nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'No tienes permiso para editar la historia.' });

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
    res.status(500).json({ error: 'Error al guardar la historia' });
  }
});


// ══════════════════════════════════════════════════════════
//  VIDEO — /discos/:id/video
// ══════════════════════════════════════════════════════════

// PUT — asignar o cambiar el video principal (solo admin)
app.put('/discos/:id/video', async (req, res) => {
  const { id } = req.params;
  const { youtube_id, descripcion, nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'No tienes permiso para editar el video.' });

  try {
    if (!youtube_id) {
      // Sin youtube_id → eliminar el video principal
      await pool.query(
        "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
        [id]
      );
      return res.json({ mensaje: 'Video eliminado' });
    }

    const r = await pool.query(
      `INSERT INTO producto_video (id_producto, youtube_id, tipo, descripcion)
       VALUES ($1, $2, 'principal', $3)
       ON CONFLICT (id_producto, tipo) DO UPDATE
         SET youtube_id  = EXCLUDED.youtube_id,
             descripcion = EXCLUDED.descripcion
       RETURNING *`,
      [id, youtube_id, descripcion ?? null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /video:', err.message);
    res.status(500).json({ error: 'Error al guardar el video' });
  }
});

// DELETE — quitar el video principal (solo admin)
app.delete('/discos/:id/video', async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario } = req.body;

  if (!(await esAdmin(nombre_usuario)))
    return res.status(403).json({ error: 'No tienes permiso.' });

  try {
    await pool.query(
      "DELETE FROM producto_video WHERE id_producto = $1 AND tipo = 'principal'",
      [id]
    );
    res.json({ mensaje: 'Video eliminado' });
  } catch (err) {
    console.error('DELETE /video:', err.message);
    res.status(500).json({ error: 'Error al eliminar el video' });
  }
});


//  INICIO DEL SERVIDOR

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  pool.query('SELECT NOW()', (err) => {
    if (err) console.error('ERROR DE CONEXIÓN A DB:', err.message);
    else     console.log('Conexión a PostgreSQL exitosa.');
  });
});
