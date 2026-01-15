import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import pino from 'pino';
import http from 'http';
// --- INICIO DE LA CORRECCIÓN ---
// Esta es la forma de importar un módulo CommonJS (como whatsapp-web.js)
// dentro de un módulo ES (tu server.js)
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
// --- FIN DE LA CORRECCIÓN ---
import qrcode from 'qrcode';

// ============================================================
// 1. CONFIGURACIÓN Y VARIABLES DE ENTORNO
// ============================================================
dotenv.config();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const SESSION_NAME = process.env.WPP_SESSION_NAME || 'default-session';
const SESSION_PATH = process.env.WPP_SESSION_PATH || './wpp_session_data';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!AUTH_TOKEN) {
  console.error('FATAL ERROR: AUTH_TOKEN is not defined. The server cannot start securely.');
  process.exit(1);
}

// ============================================================
// 2. LOGGER (PINO)
// ============================================================
const transport = NODE_ENV === 'development'
? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname' },
  }
: undefined;

const logger = pino({ level: LOG_LEVEL, transport });

// ============================================================
// 3. CLASE DE ERROR PERSONALIZADA
// ============================================================
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4')? 'fail' : 'error';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================
// 4. GESTIÓN DE ESTADO Y SERVICIO DE WHATSAPP (whatsapp-web.js)
// ============================================================
const SESSION_STATE = {
  client: null,
  status: 'disconnected', // 'disconnected', 'qr', 'connecting', 'connected', 'error'
  qr: null, // Almacenará el QR en formato base64 Data URL
};

async function initializeWhatsApp() {
  if (SESSION_STATE.client) {
    logger.info('WhatsApp client already exists.');
    return;
  }

  logger.info('Creating new whatsapp-web.js client...');
  SESSION_STATE.status = 'connecting';

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH, clientId: SESSION_NAME }),
    puppeteer: {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security',
        '--no-first-run',
        '--no-default-browser-check',
        '--single-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ],
      timeout: 60000, // Aumentar timeout para Railway
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    qrMaxRetries: 3, // Limitar intentos de QR
  });

  // Evento: Autenticación (cuando existe sesión guardada)
  client.on('authenticated', () => {
    logger.info('Client authenticated with saved session!');
    SESSION_STATE.status = 'connecting';
    SESSION_STATE.qr = null; // No necesita QR si hay sesión
  });

  // Evento: Generación de QR (solo si no hay sesión guardada)
  client.on('qr', async (qrString) => {
    try {
      const base64Qr = await qrcode.toDataURL(qrString);
      SESSION_STATE.qr = base64Qr;
      SESSION_STATE.status = 'qr';
      logger.info('New QR code available. Scan to connect.');
    } catch (err) {
      logger.error(err, 'Error generating QR code data URL');
    }
  });

  // Evento: Cliente listo y conectado
  client.on('ready', () => {
    logger.info('Client is ready and connected!');
    SESSION_STATE.status = 'connected';
    SESSION_STATE.qr = null;
  });

  // Evento: Cliente desconectado
  client.on('disconnected', (reason) => {
    logger.warn({ reason }, 'Client was disconnected');

    // Si se alcanzó el máximo de reintentos de QR, no intentar reconectar automáticamente
    if (reason === 'Max qrcode retries reached') {
      logger.warn('Max QR retries reached. Client will not auto-reconnect. Use /api/init to restart.');
      // Limpiar el cliente para evitar fugas de memoria
      const clientToDestroy = SESSION_STATE.client;
      SESSION_STATE.client = null;
      SESSION_STATE.status = 'error';
      SESSION_STATE.qr = null;

      if (clientToDestroy) {
        clientToDestroy.destroy().catch(err => logger.error(err, 'Error destroying client'));
      }
      return;
    }

    // Para otras razones de desconexión, resetear el estado normalmente
    SESSION_STATE.client = null;
    SESSION_STATE.status = 'disconnected';
    SESSION_STATE.qr = null;
  });

  // Evento: Falla de autenticación (ej. sesión eliminada en el teléfono)
  client.on('auth_failure', (msg) => {
    logger.error({ msg }, 'AUTHENTICATION FAILURE. Closing session.');
    closeSession(); // Forzar cierre y limpieza
  });

  // Evento: Error remoto (errores de navegación de Puppeteer)
  client.on('remote_session_saved', () => {
    logger.info('Remote session saved successfully');
  });

  // Manejo de errores del cliente
  client.on('change_state', (state) => {
    logger.info(`Client state changed to: ${state}`);
  });

  // Manejo de errores de loading screen
  client.on('loading_screen', (percent, message) => {
    logger.info(`Loading screen: ${percent}% - ${message}`);
  });

  SESSION_STATE.client = client;

  try {
    // Iniciar la inicialización. Esto NO se bloquea en los endpoints HTTP.
    await client.initialize();
  } catch (error) {
    logger.error(error, 'Error initializing whatsapp-web.js client');
    SESSION_STATE.client = null;
    SESSION_STATE.status = 'error';
  }
}

async function closeSession() {
  if (SESSION_STATE.client) {
    logger.info('Disconnecting WhatsApp session...');
    try {
      await SESSION_STATE.client.destroy(); // Usar destroy() para whatsapp-web.js
    } catch (error) {
      logger.error(error, 'Error while closing WhatsApp client');
    } finally {
      // El evento 'disconnected' se encargará de resetear el estado.
      // Pero por si acaso, lo forzamos aquí también.
      SESSION_STATE.client = null;
      SESSION_STATE.status = 'disconnected';
      SESSION_STATE.qr = null;
      logger.info('WhatsApp session disconnected and state reset.');
    }
  }
}

// ============================================================
// 5. MIDDLEWARES
// ============================================================

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('Authorization header missing or malformed', 401));
  }
  const token = authHeader.split(' ')[1];
  if (token !== AUTH_TOKEN) {
    return next(new AppError('Invalid authentication token', 403));
  }
  next();
};

const errorHandler = (err, req, res, next) => {
  logger.error(err);
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ status: err.status, message: err.message });
  }
  if (NODE_ENV === 'development') {
    return res.status(500).json({ status: 'error', message: err.message, stack: err.stack });
  }
  return res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

// ============================================================
// 6. CONFIGURACIÓN DE LA APP EXPRESS
// ============================================================
const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors());
app.use(express.json());

// ============================================================
// 7. RUTAS (ENDPOINTS)
// ============================================================

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health/ready', (req, res) => {
  if (SESSION_STATE.status === 'connected') {
    return res.status(200).json({ status: 'ready' });
  }
  return res.status(503).json({ status: 'not_ready', reason: SESSION_STATE.status });
});

app.use('/api', authMiddleware);

// --- Rutas de Sesión (Modificadas para no ser bloqueantes) ---
app.get('/api/status', (req, res) => {
  res.status(200).json({
    status: SESSION_STATE.status,
    hasQr: !!SESSION_STATE.qr,
  });
});

app.post('/api/init', async (req, res, next) => {
  try {
    if (SESSION_STATE.status === 'connected') {
      return res.status(200).json({ message: 'Client is already connected', status: 'connected' });
    }

    if (SESSION_STATE.status === 'connecting' || SESSION_STATE.status === 'qr') {
      return res.status(200).json({ message: 'Client is already initializing', status: SESSION_STATE.status });
    }

    // Iniciar el cliente
    initializeWhatsApp();

    return res.status(202).json({ message: 'WhatsApp client initialization started', status: 'connecting' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr', async (req, res, next) => {
  try {
    if (SESSION_STATE.status === 'connected') {
      return res.status(200).json({ message: 'Client is already connected' });
    }

    if (SESSION_STATE.status === 'qr' && SESSION_STATE.qr) {
      // El QR ya existe, enviarlo
      return res.status(200).json({ qr: SESSION_STATE.qr });
    }

    if (SESSION_STATE.status === 'connecting') {
      return res.status(202).json({ message: 'Client is connecting, QR will be available soon...' });
    }

    // Si está desconectado o en error, sugerir usar /api/init
    if (SESSION_STATE.status === 'disconnected' || SESSION_STATE.status === 'error') {
      return res.status(400).json({ message: 'Client not initialized. Use POST /api/init first', status: SESSION_STATE.status });
    }

    // Estado inesperado
    return res.status(500).json({ message: 'Unexpected state', status: SESSION_STATE.status });
  } catch (error) {
    next(error);
  }
});

app.post('/api/disconnect', async (req, res, next) => {
  try {
    await closeSession();
    res.status(200).json({ message: 'Session disconnected successfully' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reconnect', async (req, res, next) => {
  try {
    await closeSession();
    initializeWhatsApp(); // Inicia en segundo plano, NO se espera (await)
    res.status(200).json({ message: 'Reconnection process initiated.' });
  } catch (error) {
    next(error);
  }
});

// --- Ruta de Envío de Mensajes ---
const validateMessage = [
  body('to').notEmpty().withMessage('El parámetro "to" es requerido'),
  body('message').notEmpty().withMessage('El parámetro "message" es requerido'),
];

app.post('/api/send', validateMessage, async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    if (SESSION_STATE.status !== 'connected' || !SESSION_STATE.client) {
      throw new AppError('WhatsApp client is not connected.', 409);
    }
    const { to, message } = req.body;
    const formattedTo = `${to.replace(/\D/g, '')}@c.us`;
    
    // Usar client.sendMessage
    const result = await SESSION_STATE.client.sendMessage(formattedTo, message);
    
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 8. MANEJO DE ERRORES Y 404
// ============================================================
app.use((req, res, next) => {
  next(new AppError(`No se puede encontrar ${req.originalUrl} en este servidor!`, 404));
});

app.use(errorHandler);

// ============================================================
// 9. INICIO DEL SERVIDOR Y CIERRE ELEGANTE
// ============================================================
const startServer = () => {
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} in ${NODE_ENV} mode`);
    logger.info(`Session Path: ${SESSION_PATH}`);
    logger.info('WhatsApp client will initialize on first /api/qr or /api/reconnect request');

    // NO iniciar automáticamente para evitar QRs innecesarios en Railway
    // El cliente se iniciará cuando el usuario lo solicite mediante /api/qr
  });
};

const gracefulShutdown = async (signal) => {
  logger.warn(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    logger.info('HTTP server closed.');
    await closeSession();
    process.exit(0);
  });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  // Errores recuperables de Puppeteer - no cerrar el servidor
  const recoverablePuppeteerErrors = [
    'Execution context was destroyed',
    'Target closed',
    'Protocol error',
    'Session closed',
    'Navigation failed'
  ];

  const isRecoverableError = reason && reason.message &&
    recoverablePuppeteerErrors.some(errMsg => reason.message.includes(errMsg));

  if (isRecoverableError) {
    logger.warn(reason, 'Recoverable Puppeteer error detected, handling gracefully...');

    // Si el cliente estaba conectado, intentar reconectar
    if (SESSION_STATE.status === 'connected' || SESSION_STATE.status === 'connecting') {
      logger.info('Attempting automatic reconnection after Puppeteer error...');
      closeSession().then(() => {
        setTimeout(() => {
          initializeWhatsApp().catch(err => logger.error(err, 'Failed to auto-reconnect'));
        }, 5000);
      });
    } else {
      // Solo resetear el estado sin intentar reconectar
      SESSION_STATE.client = null;
      SESSION_STATE.status = 'disconnected';
      SESSION_STATE.qr = null;
    }
    return;
  }

  // Para otros errores no manejados, cerrar el proceso
  logger.fatal(reason, 'UNHANDLED REJECTION! Shutting down...');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  // Errores recuperables de Puppeteer - no cerrar el servidor
  const recoverablePuppeteerErrors = [
    'Execution context was destroyed',
    'Target closed',
    'Protocol error',
    'Session closed'
  ];

  const isRecoverableError = err.message &&
    recoverablePuppeteerErrors.some(errMsg => err.message.includes(errMsg));

  if (isRecoverableError) {
    logger.warn(err, 'Recoverable Puppeteer error detected (uncaught exception)');
    return;
  }

  logger.fatal(err, 'UNCAUGHT EXCEPTION! Shutting down...');
  process.exit(1);
});

startServer();

