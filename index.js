require('dotenv').config();
const cors = require('cors'); 
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const app = express();

// 1. CONFIGURACIÓN DE BASE DE DATOS
// Usamos el bloque ssl necesario para conectar con Neon desde Render
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false 
  }
});

// 2. MIDDLEWARES
app.use(cors()); // Permite que tu frontend en GitHub Pages haga peticiones al backend
app.use(express.json());

// --- RUTAS DE USUARIOS ---

// REGISTRO
app.post('/registro', async (req, res) => {
  const { nombre_usuario, password } = req.body;
  try {
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const query = 'INSERT INTO usuarios (nombre_usuario, password_hash) VALUES ($1, $2) RETURNING *';
    await pool.query(query, [nombre_usuario, passwordHash]);
    res.json({ mensaje: "Usuario creado con éxito" });
  } catch (error) {
    console.error("❌ ERROR EN REGISTRO:", error.message);
    res.status(500).json({ error: "El usuario ya existe o error de servidor" });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  const { nombre_usuario, password } = req.body;
  try {
    const resultado = await pool.query('SELECT * FROM usuarios WHERE nombre_usuario = $1', [nombre_usuario]);
    
    if (resultado.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    const usuario = resultado.rows[0];
    const esCorrecta = await bcrypt.compare(password, usuario.password_hash);

    if (esCorrecta) {
      res.json({ 
        nombre: usuario.nombre_usuario, 
        es_admin: usuario.es_admin 
      });
    } else {
      res.status(401).json({ error: "Contraseña incorrecta" });
    }
  } catch (error) {
    console.error("❌ ERROR EN LOGIN:", error.message);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- RUTAS DE DISCOS ---

// LEER DISCOS
app.get('/discos', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM discos ORDER BY id ASC');
    res.json(resultado.rows);
  } catch (error) {
    console.error("❌ ERROR EN DISCOS:", error.message);
    res.status(500).json({ error: "No se pudieron cargar los discos" });
  }
});

// AGREGAR DISCOS (Solo Admin)
app.post('/discos', async (req, res) => {
  const { titulo, artista, precio, stock, imagen_url, nombre_usuario } = req.body;
  try {
    const adminCheck = await pool.query('SELECT es_admin FROM usuarios WHERE nombre_usuario = $1', [nombre_usuario]);
    
    if (!adminCheck.rows[0] || !adminCheck.rows[0].es_admin) {
      return res.status(403).json({ error: "Acceso denegado: No tienes permisos de administrador." });
    }

    const query = 'INSERT INTO discos (titulo, artista, precio, stock, imagen_url) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    const resultado = await pool.query(query, [titulo, artista, precio, stock, imagen_url]);
    res.json(resultado.rows[0]);
  } catch (error) {
    console.error("❌ ERROR AL AGREGAR:", error.message);
    res.status(500).json({ error: "Error al guardar en la base de datos" });
  }
});

// ACTUALIZAR
app.put('/discos/:id', async (req, res) => {
  const { id } = req.params;
  const { titulo, artista, precio, stock, imagen_url, nombre_usuario } = req.body;

  try {
    const adminCheck = await pool.query('SELECT es_admin FROM usuarios WHERE nombre_usuario = $1', [nombre_usuario]);
    
    if (!adminCheck.rows[0]?.es_admin) {
      return res.status(403).json({ error: "No tienes permiso de administrador." });
    }

    const query = `
      UPDATE discos 
      SET titulo = $1, artista = $2, precio = $3, stock = $4, imagen_url = $5 
      WHERE id = $6 
      RETURNING *`;
    
    const valores = [titulo, artista, precio, stock, imagen_url, id];
    const resultado = await pool.query(query, valores);

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: "Disco no encontrado" });
    }

    res.json(resultado.rows[0]);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO EN PUT /discos:", error.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// BORRAR DISCOS (Solo Admin)
app.delete('/discos/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario } = req.body;
  try {
    const adminCheck = await pool.query('SELECT es_admin FROM usuarios WHERE nombre_usuario = $1', [nombre_usuario]);
    
    if (!adminCheck.rows[0] || !adminCheck.rows[0].es_admin) {
      return res.status(403).json({ error: "No tienes permiso para borrar discos." });
    }

    await pool.query('DELETE FROM discos WHERE id = $1', [id]);
    res.json({ mensaje: "Disco eliminado correctamente" });
  } catch (error) {
    console.error("❌ ERROR AL BORRAR:", error.message);
    res.status(500).json({ error: "Error al eliminar el disco" });
  }
});

// RUTA ESPECIAL PARA COMPRAS
app.post('/discos/:id/compra', async (req, res) => {
  const { id } = req.params;
  
  try {
    const disco = await pool.query('SELECT stock FROM discos WHERE id = $1', [id]);
    
    if (disco.rows.length === 0) return res.status(404).json({ error: "Disco no encontrado" });
    
    const stockActual = disco.rows[0].stock;
    
    if (stockActual <= 0) {
      return res.status(400).json({ error: "No hay stock disponible" });
    }

    const nuevoStock = stockActual - 1;
    await pool.query('UPDATE discos SET stock = $2 WHERE id = $1', [id, nuevoStock]);

    res.json({ mensaje: "Compra procesada", nuevoStock });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al procesar la compra" });
  }
});

// INICIO DEL SERVIDOR
// Usamos el puerto asignado por Render o el 3000 por defecto
const PORT = process.env.PORT || 3000; 

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
  
  // Prueba de salud de la base de datos
  pool.query('SELECT NOW()', (err) => {
    if (err) {
      console.log("❌ ERROR DE CONEXIÓN A DB:", err.message);
    } else {
      console.log("✅ Conexión a PostgreSQL exitosa.");
    }
  });
});
