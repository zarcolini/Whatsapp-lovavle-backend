// ================================================================= //
// =================== CÓDIGO MODIFICADO PARA BAILEYS v7.x.x =================== //
// ================================================================= //

// CAMBIO: Se usan 'import' en lugar de 'require' (Sintaxis ESM)
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

// CAMBIO: Lógica para obtener __dirname en proyectos ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------- //
//                      CONFIGURACIÓN IMPORTANTE                      //
// ---------------------------------------------------------------- //
const BEARER_TOKEN = process.env.BEARER_TOKEN || "TU_TOKEN_SECRETO";
const PORT = process.env.PORT || 3000;
// ---------------------------------------------------------------- //

const app = express();
app.use(express.json());

// CORS MEJORADO: Sin cambios requeridos aquí
app.use((req, res, next) => {
  const allowedOrigins = [
    "https://whatsapp-lovavle-frontend.vercel.app", // Asegúrate que no tenga la barra al final
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5500",
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.set("trust proxy", true);

// Variables de estado (sin cambios en su definición)
let sock;
let qrCode;
let connectionStatus = "inicializando";
let isAuthenticated = false;
let reconnectAttempts = 0;
let isReconnecting = false;
let shouldReconnect = true;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000;
const authDir = path.join(__dirname, "auth_info_baileys");

// Middleware de autenticación (sin cambios)
const authenticate = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token === BEARER_TOKEN) {
      next();
    } else {
      res.status(403).json({ error: "Prohibido. El token no es válido." });
    }
  } else {
    res.status(401).json({
      error:
        "No autorizado. Proporciona un Bearer Token válido en el header Authorization.",
    });
  }
};

// Función para limpiar la sesión (sin cambios)
async function cleanupSession() {
  console.log("🧹 Limpiando sesión anterior...");
  if (sock) {
    try {
      sock.end();
      sock.removeAllListeners();
    } catch (error) {
      console.log("⚠️ Error al cerrar socket:", error.message);
    }
    sock = null;
  }
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("📁 Directorio de autenticación eliminado");
    } catch (error) {
      console.log("⚠️ Error al eliminar directorio:", error.message);
    }
  }
  qrCode = null;
  isAuthenticated = false;
  connectionStatus = "desconectado";
  isReconnecting = false;
}

// Función para reconectar (sin cambios)
async function attemptReconnect() {
  if (isReconnecting || !shouldReconnect) {
    console.log("⏸️ Reconexión ya en proceso o deshabilitada");
    return;
  }
  isReconnecting = true;
  reconnectAttempts++;
  console.log(
    `🔄 Intento de reconexión ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`
  );
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.log(
      "⚠️ Máximo de intentos alcanzado. Requiere intervención manual."
    );
    connectionStatus = "error_reconexion";
    isReconnecting = false;
    reconnectAttempts = 0;
    await cleanupSession();
    console.log("📱 Se requiere escanear nuevo código QR");
    setTimeout(() => {
      if (shouldReconnect) connectToWhatsApp();
    }, RECONNECT_DELAY);
    return;
  }
  const delay = RECONNECT_DELAY * Math.min(reconnectAttempts, 3);
  console.log(`⏱️ Esperando ${delay / 1000} segundos antes de reconectar...`);
  setTimeout(() => {
    isReconnecting = false;
    if (shouldReconnect) connectToWhatsApp();
  }, delay);
}

// Función principal de conexión (sin cambios en la lógica interna)
async function connectToWhatsApp() {
  if (connectionStatus === "conectando" || connectionStatus === "conectado") {
    console.log("⚠️ Ya hay una conexión activa o en proceso");
    return;
  }
  console.log("🔄 Iniciando conexión con WhatsApp...");
  connectionStatus = "conectando";
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const hasAuth = state.creds && state.creds.me;
    console.log("🔑 Credenciales existentes:", hasAuth ? "Sí" : "No");
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrCode = qr;
        isAuthenticated = false;
        connectionStatus = "esperando_qr";
        reconnectAttempts = 0;
        console.log("📱 Nuevo código QR generado");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output
          ?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConflict = statusCode === DisconnectReason.connectionReplaced;
        const isBadSession = statusCode === DisconnectReason.badSession;
        console.log("❌ Conexión cerrada. Razón:", DisconnectReason[statusCode] || 'Desconocida', "Código:", statusCode);
        connectionStatus = "desconectado";
        isAuthenticated = false;
        qrCode = null;
        if (isLoggedOut || isBadSession) {
          console.log("🔓 Sesión cerrada o corrupta. Limpiando...");
          reconnectAttempts = 0;
          await cleanupSession();
          setTimeout(() => {
            if (shouldReconnect) connectToWhatsApp();
          }, 3000);
        } else if (isConflict) {
          console.log("⚠️ Sesión reemplazada. No se reconectará.");
          shouldReconnect = false;
          await cleanupSession();
        } else if (shouldReconnect) {
           await attemptReconnect();
        }
      } else if (connection === "open") {
        connectionStatus = "conectado";
        isAuthenticated = true;
        qrCode = null;
        reconnectAttempts = 0;
        isReconnecting = false;
        console.log("✅ ¡Conectado a WhatsApp exitosamente!");
        console.log("📱 Número:", sock.user?.id);
      } else if (connection === "connecting") {
        connectionStatus = "conectando";
        console.log("🔄 Conectando a WhatsApp...");
      }
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("error", (error) => {
      console.error("❌ Error en el socket:", error);
      connectionStatus = "error";
    });
  } catch (error) {
    console.error("❌ Error al conectar:", error);
    connectionStatus = "error";
    isReconnecting = false;
    if (shouldReconnect) await attemptReconnect();
  }
}

// --- ENDPOINTS DE LA API (sin cambios, excepto en la lógica de envío) ---
app.get("/", (req, res) => {
  res.send(`<h1>✅ API de WhatsApp Activa</h1><p><b>Estado:</b> ${connectionStatus}</p>`);
});
app.get("/estado", authenticate, (req, res) => {
  res.status(200).json({
    status: connectionStatus,
    isAuthenticated,
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
    res.status(200).json({ message: "QR no disponible." });
  }
});

// Función de ayuda para formatear el JID
const formatJid = (number) => {
    if (number.includes('@')) {
        return number; // Ya es un JID completo (PN o LID)
    }
    // Si no tiene '@', asumimos que es un número de teléfono (PN) y le damos formato
    return `${number}@s.whatsapp.net`;
}

// Endpoint para enviar mensajes
app.post("/enviar", authenticate, async (req, res) => {
  if (!isAuthenticated) {
    return res.status(409).json({ error: "WhatsApp no está conectado." });
  }
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: "Los campos `number` y `message` son requeridos." });
  }
  try {
    const jid = formatJid(number);
    await sock.sendMessage(jid, { text: message });
    res.status(200).json({ status: "éxito", message: "Mensaje enviado." });
  } catch (error) {
    console.error("Error enviando mensaje:", error);
    res.status(500).json({ error: "Error interno al enviar el mensaje." });
  }
});

// Endpoint para enviar imagen desde una URL
app.post("/enviar-imagen-url", authenticate, async (req, res) => {
    if (!isAuthenticated) {
        return res.status(409).json({ error: "WhatsApp no está conectado." });
    }
    const { number, imageUrl, caption } = req.body;
    if (!number || !imageUrl) {
        return res.status(400).json({ error: "Los campos `number` y `imageUrl` son requeridos." });
    }
    try {
        const jid = formatJid(number);
        const messageData = {
            image: { url: imageUrl },
            caption: caption || "",
        };
        await sock.sendMessage(jid, messageData);
        res.status(200).json({ status: "éxito", message: "Imagen enviada." });
    } catch (error) {
        console.error("Error enviando imagen:", error);
        res.status(500).json({ error: "Error interno al enviar la imagen." });
    }
});

app.post("/reconectar", authenticate, async (req, res) => {
  console.log("🔄 Reconexión manual solicitada");
  shouldReconnect = true;
  reconnectAttempts = 0;
  isReconnecting = false;
  await cleanupSession();
  res.status(200).json({ message: "Sesión limpiada. Generando nuevo QR..." });
  setTimeout(connectToWhatsApp, 2000);
});

// Iniciar servidor y conexión
app.listen(PORT, () => {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║      API WhatsApp - Servidor Iniciado      ║");
  console.log("╠════════════════════════════════════════════╣");
  console.log(`║ 🚀 Puerto: ${PORT}                            ║`);
  console.log("╚════════════════════════════════════════════╝");
  connectToWhatsApp();
});