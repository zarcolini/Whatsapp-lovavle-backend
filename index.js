import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
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

// --- Lógica para obtener __dirname en proyectos ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuración Importante ---
const BEARER_TOKEN = process.env.BEARER_TOKEN || "TU_TOKEN_SECRETO";
const PORT = process.env.PORT || 3000;

// --- Verificación de Token ---
if (BEARER_TOKEN === "TU_TOKEN_SECRETO") {
  console.warn(
    "ADVERTENCIA: Estás usando el Bearer Token por defecto. Por favor, configura una variable de entorno segura."
  );
}

// --- Estado Global de WhatsApp ---
let sock;
let qrCode;
let connectionStatus = "inicializando";
let isAuthenticated = false;
const authDir = path.join(__dirname, "auth_info_baileys");

// --- Funciones de WhatsApp (Baileys) ---

// Función para limpiar la sesión anterior
async function cleanupSession() {
  console.log("Limpiando sesión anterior...");
  if (sock) {
    try {
      sock.end();
      sock.removeAllListeners();
    } catch (error) {
      console.warn("Error al cerrar socket:", error.message);
    }
  }
  sock = null;
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("Directorio de autenticación eliminado.");
    } catch (error) {
      console.warn("Error al eliminar directorio de autenticación:", error.message);
    }
  }
  qrCode = null;
  isAuthenticated = false;
  connectionStatus = "desconectado";
}

// Función principal de conexión a WhatsApp
async function connectToWhatsApp() {
  if (connectionStatus === "conectando" || connectionStatus === "conectado") {
    console.warn("Conexión ya en proceso o activa.");
    return;
  }

  console.log("Iniciando conexión con WhatsApp...");
  connectionStatus = "conectando";

  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
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
      connectionStatus = "esperando_qr";
      console.log("Nuevo código QR generado. Por favor, escanéalo.");
    }

    if (connection === "close") {
      isAuthenticated = false;
      const statusCode =
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.connectionReplaced;

      connectionStatus = "desconectado";
      console.error(
        `Conexión cerrada. Razón: ${DisconnectReason[statusCode] || "Desconocida"
        }`
      );

      if (shouldReconnect) {
        console.log("Intentando reconectar en 5 segundos...");
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log(
          "No se reconectará automáticamente. Limpiando sesión..."
        );
        await cleanupSession();
      }
    } else if (connection === "open") {
      isAuthenticated = true;
      qrCode = null;
      connectionStatus = "conectado";
      console.log(
        `Conectado a WhatsApp! Número: ${sock.user?.id.split(":")[0]}`
      );
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Función de ayuda para formatear el JID
const formatJid = (number) => {
  return number.includes("@") ? number : `${number}@s.whatsapp.net`;
};

// --- Configuración del Servidor (Express) ---

const app = express();

// Middlewares de Seguridad
app.use(helmet());
app.use(cors({ origin: "*" })); // Para producción, considera limitar los orígenes
app.use(express.json());

// Límite de Peticiones (Rate Limiter)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limita cada IP a 100 peticiones por ventana de tiempo
  standardHeaders: true,
  legacyHeaders: false,
  message: "Demasiadas peticiones desde esta IP, por favor intenta de nuevo en 15 minutos."
});
app.use(limiter);

// Middleware de Autenticación
const authenticate = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token === BEARER_TOKEN) {
      return next();
    }
  }
  res.status(401).json({
    error: "No autorizado. Token inválido o no proporcionado.",
  });
};

// --- Rutas de la API ---

app.get("/", (req, res) => {
  res.send(
    `<h1>API de WhatsApp Activa</h1><p><b>Estado:</b> ${connectionStatus}</p>`
  );
});

app.get("/estado", authenticate, (req, res) => {
  res.status(200).json({
    connection: connectionStatus,
    isAuthenticated: isAuthenticated,
    hasQR: !!qrCode,
    user: sock?.user || null,
  });
});

app.get("/qr", authenticate, (req, res) => {
  if (qrCode) {
    res.type("text/plain").send(qrCode);
  } else if (isAuthenticated) {
    res.status(200).json({ message: "Ya está autenticado." });
  } else {
    res.status(404).json({ message: "QR no disponible en este momento." });
  }
});

app.post("/enviar", authenticate, async (req, res, next) => {
  if (!isAuthenticated) {
    return res
      .status(409)
      .json({ error: "WhatsApp no está conectado." });
  }
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res
        .status(400)
        .json({ error: "Los campos `number` y `message` son requeridos." });
    }
    const jid = formatJid(number);
    await sock.sendMessage(jid, { text: message });
    res.status(200).json({ status: "éxito", message: "Mensaje enviado." });
  } catch (error) {
    next(error);
  }
});

app.post("/reconectar", authenticate, async (req, res) => {
  await cleanupSession();
  connectToWhatsApp();
  res.status(200).json({
    message: "Sesión limpiada. Intentando generar un nuevo QR...",
  });
});

// Middleware Centralizado para Manejo de Errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Ocurrió un error interno en el servidor.",
    message: err.message,
  });
});

// --- Arranque del Servidor ---

const server = app.listen(PORT, () => {
  console.log("==============================================");
  console.log("     API WhatsApp - Servidor Iniciado");
  console.log("==============================================");
  console.log(`Servidor escuchando en el puerto: ${PORT}`);
  
  connectToWhatsApp();
});

// Cierre Controlado (Graceful Shutdown)
const cleanupOnExit = async () => {
  console.log("\nApagando servidor...");
  server.close(async () => {
    console.log("Servidor HTTP cerrado.");
    if (sock) {
      await sock.logout("Cierre controlado del servidor");
      console.log("Sesión de WhatsApp cerrada.");
    }
    process.exit(0);
  });
};

process.on("SIGINT", cleanupOnExit);
process.on("SIGTERM", cleanupOnExit);