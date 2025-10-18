import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion, // <--- CAMBIO IMPORTANTE
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import express from "express";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// --- Logger Mejorado ---
const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

// --- Lógica para obtener __dirname en proyectos ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuración ---
const BEARER_TOKEN = process.env.BEARER_TOKEN || "TU_TOKEN_SECRETO";
const PORT = process.env.PORT || 3000;

// --- Estado Global ---
let sock;
let qrCode;
let connectionState = {
  status: "inicializando",
  isAuthenticated: false,
  isReconnecting: false,
};
const authDir = path.join(__dirname, "auth_info_baileys");

// --- Funciones de WhatsApp (Baileys) ---

async function cleanupSession() {
  logger.info("Limpiando sesión anterior...");
  if (sock) {
    try {
      sock.end(undefined);
    } catch (error) {
      logger.warn({ err: error.message }, "Error al cerrar socket");
    }
  }
  sock = null;
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info("Directorio de autenticación eliminado.");
    } catch (error) {
      logger.warn({ err: error.message }, "Error al eliminar directorio de autenticación");
    }
  }
  qrCode = null;
  connectionState = { status: "desconectado", isAuthenticated: false, isReconnecting: false };
}

async function connectToWhatsApp() {
  if (connectionState.status === "conectando" || connectionState.status === "conectado") {
    logger.warn("Conexión ya en proceso o activa.");
    return;
  }
  
  connectionState.status = "conectando";
  logger.info("Iniciando conexión con WhatsApp...");

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    
    // --- CAMBIO CRÍTICO: Obtener la última versión de Baileys ---
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Usando la versión de Baileys: ${version.join('.')}, ¿es la última?: ${isLatest}`);

    sock = makeWASocket({
      version, // <--- CAMBIO CRÍTICO
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        connectionState.status = "esperando_qr";
      }

      if (connection === "close") {
        connectionState.isAuthenticated = false;
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || "Desconocida";
        logger.error({ reason, statusCode }, "Conexión cerrada.");

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.connectionReplaced &&
          statusCode !== DisconnectReason.badSession;

        if (shouldReconnect && !connectionState.isReconnecting) {
          connectionState.isReconnecting = true;
          logger.info("Intentando reconectar en 10 segundos...");
          setTimeout(() => {
            connectionState.isReconnecting = false;
            connectToWhatsApp();
          }, 10000);
        } else if (!shouldReconnect) {
          logger.warn("No se reconectará automáticamente. Limpiando sesión para un nuevo inicio.");
          await cleanupSession();
        }
      } else if (connection === "open") {
        connectionState.isAuthenticated = true;
        qrCode = null;
        connectionState.status = "conectado";
        logger.info(`Conectado a WhatsApp! Número: ${sock.user?.id.split(":")[0]}`);
      }
    });

    sock.ev.on("creds.update", saveCreds);

  } catch (error) {
    logger.error({ err: error.stack }, "Error fatal durante la conexión a WhatsApp.");
    connectionState.status = 'error';
  }
}

// --- Configuración del Servidor (Express) ---
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Demasiadas peticiones desde esta IP, por favor intenta de nuevo en 15 minutos."
}));

// --- Middleware de Autenticación ---
const authenticate = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ") && authHeader.substring(7) === BEARER_TOKEN) {
    return next();
  }
  res.status(401).json({ error: "No autorizado." });
};

// --- Rutas de la API ---
app.get("/", (req, res) => {
  res.send(`<h1>API de WhatsApp Activa</h1><p><b>Estado:</b> ${connectionState.status}</p>`);
});

app.get("/estado", authenticate, (req, res) => {
  res.status(200).json({
    connection: connectionState.status,
    isAuthenticated: connectionState.isAuthenticated,
    hasQR: !!qrCode,
    user: sock?.user || null,
  });
});

app.get("/qr", authenticate, (req, res) => {
  if (qrCode) {
    res.type("text/plain").send(qrCode);
  } else if (connectionState.isAuthenticated) {
    res.status(200).json({ message: "Ya está autenticado." });
  } else {
    res.status(404).json({ message: "QR no disponible. El servidor puede estar conectándose." });
  }
});

app.post("/enviar", authenticate, async (req, res, next) => {
  if (!connectionState.isAuthenticated) {
    return res.status(409).json({ error: "WhatsApp no está conectado." });
  }
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: "Los campos 'number' y 'message' son requeridos." });
    }
    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.status(200).json({ status: "éxito", message: "Mensaje enviado." });
  } catch (error) {
    next(error);
  }
});

app.post("/reconectar", authenticate, async (req, res) => {
  logger.info("Reconexión manual solicitada.");
  await cleanupSession();
  connectToWhatsApp();
  res.status(200).json({ message: "Sesión limpiada. Intentando generar un nuevo QR..." });
});

// --- Middleware de Errores ---
app.use((err, req, res, next) => {
  logger.error({ err: err.stack }, "Ocurrió un error interno en el servidor.");
  res.status(500).json({ error: "Error interno en el servidor.", message: err.message });
});

// --- Arranque del Servidor ---
const server = app.listen(PORT, () => {
  logger.info("==============================================");
  logger.info("     API WhatsApp - Servidor Iniciado");
  logger.info("==============================================");
  logger.info(`Servidor escuchando en el puerto: ${PORT}`);
  connectToWhatsApp();
});

// --- Cierre Controlado (Graceful Shutdown) ---
const cleanupOnExit = () => {
  logger.info("\nApagando servidor...");
  server.close(async () => {
    logger.info("Servidor HTTP cerrado.");
    if (sock) {
      await sock.logout("Cierre controlado del servidor");
      logger.info("Sesión de WhatsApp cerrada.");
    }
    process.exit(0);
  });
};

process.on("SIGINT", cleanupOnExit);
process.on("SIGTERM", cleanupOnExit);