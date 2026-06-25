# VinylVibes — Backend

API REST del proyecto VinylVibes, construida con Node.js y Express, hospedada en Render.

---

## Stack

| Tecnología | Uso |
|---|---|
| Node.js + Express | Servidor y endpoints |
| Prisma | ORM para PostgreSQL |
| PostgreSQL (Neon) | Base de datos |
| Redis (Render) | Caché de respuestas |
| JWT + bcrypt | Autenticación |
| express-rate-limit | Protección contra abuso |
| ioredis | Cliente de Redis |

---

## Archivos

```
├── index.js              → servidor principal y endpoints
├── package.json          → dependencias
└── prisma/
    └── schema.prisma     → esquema de la base de datos
```

---

## Variables de entorno

Configurar en Render → Environment (o en `.env` para desarrollo local):

```env
DATABASE_URL      = postgresql://...@neon.tech/neondb
JWT_SECRET        = clave_secreta_larga
CORS_ORIGIN       = https://usuario.github.io,https://otro-dominio.com
REDIS_URL         = redis://red-...
DISCOGS_TOKEN     = token_de_discogs
YOUTUBE_API_KEY   = clave_de_youtube
LASTFM_API_KEY    = clave_de_lastfm
```

> `CORS_ORIGIN` acepta múltiples dominios separados por coma.  
> El servidor no arranca si `JWT_SECRET` no está definido.

---

## Roles de usuario

| Rol | Descripción |
|---|---|
| `cliente` | Rol por defecto al registrarse. Puede comprar y ver su historial. |
| `vendedor` | Acceso futuro a gestión de inventario. |
| `admin` | Acceso completo: usuarios, ventas y diagnóstico. |
| `demo` | Solo lectura de secciones admin. No puede escribir ni modificar datos. |

---

## Endpoints

### Auth
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/registro` | — | Crear cuenta |
| POST | `/login` | — | Iniciar sesión, devuelve JWT |

> Rate limit en auth: máximo 10 intentos cada 15 minutos.

### Catálogo (Discogs)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/buscar?q=&pagina=` | — | Buscar discos |
| GET | `/recientes` | — | Discos del año actual |
| GET | `/genero/:genero?pagina=` | — | Discos por género |
| GET | `/disco/:id` | — | Detalle de un disco |
| GET | `/disco/:id/historia` | — | Historia del álbum (Last.fm) |
| GET | `/disco/:id/video` | — | Video del álbum (YouTube) |
| GET | `/disco/:id/recomendaciones` | Opcional | Recomendaciones (personalizadas si hay token) |

### Usuario
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/historial` | [JWT] | Registrar disco visto (máx. 10 por usuario) |
| GET | `/historial` | [JWT] | Historial de navegación |
| POST | `/checkout` | [JWT] | Procesar compra (precio calculado en backend) |
| GET | `/mis-compras` | [JWT] | Historial de compras del usuario |

### Admin
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/admin/usuarios` | [admin, demo] | Listar todos los usuarios |
| PUT | `/admin/usuarios/:id/rol` | [admin] | Cambiar rol de un usuario |
| DELETE | `/admin/usuarios/:id` | [admin] | Eliminar usuario |
| GET | `/admin/ventas` | [admin, demo] | Listar todas las ventas |
| GET | `/admin/ventas/:id` | [admin, demo] | Detalle de una venta |
| PUT | `/admin/ventas/:id/estado` | [admin] | Cambiar estado de una venta |
| GET | `/redis-ping` | [admin, demo] | Diagnóstico de Redis |

---

## Base de datos

```
usuario           → autenticación y roles
venta             → órdenes de compra
linea_venta       → discos por orden (con discogs_id y precio calculado en backend)
envio             → dirección de envío por orden
historial_usuario → últimos 10 discos vistos por usuario
```

---

## Caché Redis

| Dato | TTL |
|---|---|
| Búsquedas | 1 hora |
| Géneros | 24 horas |
| Recientes | 24 horas |
| Detalle disco | 7 días |
| Historia | 7 días |
| Video | 7 días |
| Recomendaciones | 1 hora |

---

## Rate limiting

| Ámbito | Límite |
|---|---|
| Global (todas las rutas) | 100 peticiones / minuto |
| `/registro` y `/login` | 10 intentos / 15 minutos |

---

## Instalación local

```bash
git clone https://github.com/tu-usuario/vinylvibes-backend
cd vinylvibes-backend
npm install        # también ejecuta prisma generate (postinstall)
# Crear archivo .env con las variables de entorno
node index.js
```

Para aplicar migraciones de base de datos:

```bash
npx prisma migrate deploy
```

---

## Ejemplos de request / response

### POST /registro

```json
// Request
{
  "nombre_usuario": "juan",
  "password": "mipassword123"
}

// Response 201
{
  "mensaje": "Usuario creado exitosamente."
}

// Response 409 (usuario ya existe)
{
  "error": "El nombre de usuario ya está en uso."
}
```

### POST /login

```json
// Request
{
  "nombre_usuario": "juan",
  "password": "mipassword123"
}

// Response 200
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "nombre": "juan",
  "es_admin": false,
  "es_demo": false
}

// Response 401
{
  "error": "Credenciales inválidas."
}
```

> El token JWT tiene una duración de 7 días. Debe enviarse en el header `Authorization: Bearer <token>` en todos los endpoints protegidos.

### POST /checkout

```json
// Request
{
  "items": [
    {
      "discogs_id": "1234567",
      "titulo": "Dark Side of the Moon",
      "artista": "Pink Floyd",
      "cantidad": 1
    }
  ],
  "envio": {
    "nombre_receptor": "Juan Pérez",
    "calle": "Insurgentes Sur",
    "numero_ext": "123",
    "numero_int": "4B",
    "colonia": "Del Valle",
    "ciudad": "Ciudad de México",
    "estado": "CDMX",
    "codigo_postal": "03100",
    "referencias": "Edificio azul, portón negro"
  }
}

// Response 201
{
  "mensaje": "¡Compra procesada exitosamente!",
  "id_venta": 42,
  "total": "29.99"
}
```

> El precio no se envía en el request — el backend lo calcula consultando Discogs. Cualquier campo `precio` que envíe el cliente es ignorado.

---

## Cálculo de precios

El precio de cada disco se calcula en el backend con base en dos factores:

**Año de lanzamiento (precio base):**

| Año | Precio base |
|---|---|
| 2000 o posterior | $19.99 |
| 1980 - 1999 | $29.99 |
| 1960 - 1979 | $34.99 |
| Anterior a 1960 | $39.99 |
| Desconocido | $24.99 |

**Ajuste por popularidad** (ratio want/have en Discogs):

| Ratio | Ajuste |
|---|---|
| >= 1.5 (muy deseado) | +40% (max +$15) |
| >= 0.8 (bastante deseado) | +20% (max +$8) |
| <= 0.1 (poco deseado) | -15% (max -$5) |

---

## APIs externas y caché

El backend consume tres APIs externas. El caché en Redis existe precisamente para no agotar sus límites de uso:

| API | Para qué se usa | Rate limit aproximado |
|---|---|---|
| Discogs | Búsqueda, detalle y estadísticas de discos | 60 req/min autenticado |
| Last.fm | Historia del álbum y artistas similares | 5 req/seg |
| YouTube Data API v3 | Video del álbum | 10,000 unidades/día |

Si Redis no está disponible, el backend sigue funcionando pero consulta las APIs externas en cada request.

---

## Flujo de una compra

1. El usuario agrega discos al carrito en el frontend.
2. Completa el formulario de envío.
3. El frontend hace `POST /checkout` con los ítems (sin precio) y los datos de envío.
4. El backend consulta Discogs para obtener los stats actuales de cada disco y calcula el precio real.
5. Se crea la orden en la base de datos con estado `pagada`.
6. El admin puede actualizar el estado desde el panel.

**Estados posibles de una venta:**

| Estado | Descripción |
|---|---|
| `pendiente` | Orden creada, pago no confirmado |
| `pagada` | Pago confirmado (estado inicial en el flujo actual) |
| `enviada` | Orden despachada |
| `entregada` | Orden recibida por el cliente |
| `cancelada` | Orden cancelada |

---

## Códigos de error

| Código | Cuándo ocurre |
|---|---|
| 400 | Datos faltantes o inválidos en el request |
| 401 | Token ausente, inválido o expirado |
| 403 | El rol del usuario no tiene permiso para esa acción |
| 404 | Recurso no encontrado (disco, venta, usuario) |
| 409 | Conflicto — por ejemplo, nombre de usuario ya registrado |
| 429 | Rate limit alcanzado |
| 500 | Error interno del servidor |
---
<details>
  <summary>Modelo relacional</summary>
  <img src="https://github.com/user-attachments/assets/eb826ead-d502-454b-b3a0-a50bd8880af8" alt="Modelo relacional VinylVibes" style="max-width:100%;">
</details>

<details>
  <summary>Modelo Entidad Relacion Extendido</summary>
<img src="https://github.com/user-attachments/assets/6001af04-200a-42d1-8141-66d65fd12971" alt="Modelo Entidad Relacion Extendido VinylVibes" style="max-width:100%;">
    </details>



<details>
  <summary>Evaluación Google Lighthouse</summary>
  <img src="https://github.com/user-attachments/assets/6c680c6c-c047-4d4a-9ad0-8295bfbe4e2a" style="max-width:100%;">
    </details>


---

## Contribuir

1. Haz fork del repositorio.
2. Crea una rama para tu cambio: `git checkout -b feature/nombre-del-cambio`.
3. Haz commit de tus cambios: `git commit -m "descripción clara del cambio"`.
4. Abre un Pull Request describiendo qué cambiaste y por qué.

Para reportar un bug, abre un Issue en GitHub con el endpoint afectado, el request que lo reproduce y el error que devuelve.

---

## Licencia

ISC
