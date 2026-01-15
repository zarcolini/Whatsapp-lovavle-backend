import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import pino from 'pino';
import http from 'http';
import qrcode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';

// ============================================================
// 1. CONFIGURACIÓN Y VARIABLES DE ENTORNO
// ============================================================
dotenv.config();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const SESSION_PATH = process.env.WPP_SESSION_PATH || './baileys_auth_info';
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
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================
// 4. GESTIÓN DE ESTADO Y SERVICIO DE WHATSAPP (Baileys)
// ============================================================
const SESSION_STATE = {
  socket: null,
  status: 'disconnected', // 'disconnected', 'qr', 'connecting', 'connected', 'error'
  qr: null, // Almacenará el QR en formato base64 Data URL
  retryCount: 0,
  maxRetries: 3,
};

async function initializeWhatsApp() {
  if (SESSION_STATE.socket) {
    logger.info('WhatsApp socket already exists.');
    return;
  }

  logger.info('Creating new Baileys WhatsApp socket...');
  SESSION_STATE.status = 'connecting';

  try {
    // Cargar estado de autenticación
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    // Obtener la última versión de Baileys
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

    // Crear socket de WhatsApp
    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }), // Silenciar logs internos de Baileys
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    SESSION_STATE.socket = socket;

    // Evento: Actualización de conexión
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Generar QR si está disponible
      if (qr) {
        try {
          const base64Qr = await qrcode.toDataURL(qr);
          SESSION_STATE.qr = base64Qr;
          SESSION_STATE.status = 'qr';
          SESSION_STATE.retryCount++;

          logger.info(`QR code generated (attempt ${SESSION_STATE.retryCount}/${SESSION_STATE.maxRetries})`);

          // Verificar si se alcanzó el máximo de reintentos
          if (SESSION_STATE.retryCount >= SESSION_STATE.maxRetries) {
            logger.warn('Max QR retries reached. Stopping connection attempts.');
            SESSION_STATE.status = 'error';
            SESSION_STATE.qr = null;
            socket.end(new Error('Max QR retries reached'));
          }
        } catch (err) {
          logger.error(err, 'Error generating QR code data URL');
        }
      }

      // Manejar estado de conexión
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const isLogout = reason === DisconnectReason.loggedOut;
        const isConflict = reason === 428; // Connection taken over / Multi-device conflict

        // Don't reconnect if explicitly logged out or if we already have no socket
        const shouldReconnect = !isLogout && SESSION_STATE.socket !== null && SESSION_STATE.retryCount < SESSION_STATE.maxRetries;

        logger.warn({ reason, shouldReconnect, isLogout, isConflict }, 'Connection closed');

        SESSION_STATE.socket = null;

        if (shouldReconnect) {
          logger.info('Attempting to reconnect...');
          SESSION_STATE.status = 'connecting';
          setTimeout(() => {
            if (SESSION_STATE.socket === null) { // Double-check we still need to reconnect
              initializeWhatsApp().catch(err => logger.error(err, 'Failed to reconnect'));
            }
          }, 5000);
        } else {
          logger.warn('Not reconnecting. Either logged out or max retries reached.');
          SESSION_STATE.status = isLogout ? 'disconnected' : 'error';
          SESSION_STATE.qr = null;
          SESSION_STATE.retryCount = 0;
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp connection is now open!');
        SESSION_STATE.status = 'connected';
        SESSION_STATE.qr = null;
        SESSION_STATE.retryCount = 0; // Reset retry count on successful connection
      }
    });

    // Evento: Actualización de credenciales
    socket.ev.on('creds.update', saveCreds);

    // Evento: Mensajes (opcional, para logging)
    socket.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (msg.key.fromMe) return; // Ignorar mensajes propios

      logger.debug({ from: msg.key.remoteJid, message: msg.message }, 'Received message');
    });

  } catch (error) {
    logger.error(error, 'Error initializing Baileys WhatsApp socket');
    SESSION_STATE.socket = null;
    SESSION_STATE.status = 'error';
  }
}

async function closeSession() {
  if (SESSION_STATE.socket) {
    logger.info('Closing WhatsApp session...');
    const socketToClose = SESSION_STATE.socket;

    // Reset state first to prevent race conditions
    SESSION_STATE.socket = null;
    SESSION_STATE.status = 'disconnected';
    SESSION_STATE.qr = null;
    SESSION_STATE.retryCount = 0;

    try {
      // Only logout if socket is still connected
      if (socketToClose.ws?.readyState === 1) { // 1 = OPEN
        await socketToClose.logout();
      }
      socketToClose.end(undefined);
    } catch (error) {
      logger.error(error, 'Error while closing WhatsApp socket');
    }

    logger.info('WhatsApp session closed and state reset.');
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

// --- Rutas de Sesión ---
app.get('/api/status', (req, res) => {
  res.status(200).json({
    status: SESSION_STATE.status,
    hasQr: !!SESSION_STATE.qr,
    retryCount: SESSION_STATE.retryCount,
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

    // Resetear contador de reintentos antes de iniciar
    SESSION_STATE.retryCount = 0;

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
      return res.status(200).json({ qr: SESSION_STATE.qr });
    }

    if (SESSION_STATE.status === 'connecting') {
      return res.status(202).json({ message: 'Client is connecting, QR will be available soon...' });
    }

    if (SESSION_STATE.status === 'disconnected' || SESSION_STATE.status === 'error') {
      return res.status(400).json({ message: 'Client not initialized. Use POST /api/init first', status: SESSION_STATE.status });
    }

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
    SESSION_STATE.retryCount = 0;
    initializeWhatsApp();
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
    if (SESSION_STATE.status !== 'connected' || !SESSION_STATE.socket) {
      throw new AppError('WhatsApp client is not connected.', 409);
    }

    const { to, message } = req.body;

    // Formatear número para Baileys: número@s.whatsapp.net
    const formattedTo = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    // Enviar mensaje usando Baileys
    const result = await SESSION_STATE.socket.sendMessage(formattedTo, { text: message });

    res.status(200).json({ success: true, data: { messageId: result.key.id } });
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
    logger.info('WhatsApp client (Baileys) will initialize on first /api/init request');
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
  logger.warn(reason, 'UNHANDLED REJECTION detected');

  // En Baileys, la mayoría de errores se manejan internamente
  // Solo resetear estado si es crítico
  if (SESSION_STATE.status === 'connected') {
    logger.info('Attempting recovery...');
    SESSION_STATE.status = 'error';
  }
});

process.on('uncaughtException', (err) => {
  logger.fatal(err, 'UNCAUGHT EXCEPTION! Shutting down...');
  process.exit(1);
});

startServer();
