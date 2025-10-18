const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- //
//                          CONFIGURACIÓN IMPORTANTE                //
// ---------------------------------------------------------------- //
// Token secreto para proteger tus endpoints. Configúralo en Render.
const BEARER_TOKEN = process.env.BEARER_TOKEN || "TU_TOKEN_SECRETO";
const PORT = process.env.PORT || 3000;
// ---------------------------------------------------------------- //

const app = express();
app.use(express.json());

// CORS MEJORADO: Configuración completa para permitir peticiones desde Vercel
app.use((req, res, next) => {
  // Lista de orígenes permitidos
  const allowedOrigins = [
    "https://whatsapp-qr-ferreteria-todo-facil.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5500",
  ];

  const origin = req.headers.origin;

  // Si el origen está en la lista de permitidos, lo agregamos
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // En desarrollo, permitir cualquier origen. En producción, ser más restrictivo
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  // Headers permitidos
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400"); // Cache preflight por 24 horas

  // Responder inmediatamente a las peticiones OPTIONS (preflight)
  if (req.method === "OPTIONS") {
    res.sendStatus(204); // No Content
    return;
  }

  next();
});

app.set("trust proxy", true);

// Variables para mantener el estado de la conexión
let sock;
let qrCode;
let connectionStatus = "inicializando";
let isAuthenticated = false;
let reconnectAttempts = 0;
let isReconnecting = false; // Evita múltiples reconexiones simultáneas
let shouldReconnect = true; // Control manual de reconexión
const MAX_RECONNECT_ATTEMPTS = 3; // Reducido para evitar loops infinitos
const RECONNECT_DELAY = 5000; // 5 segundos entre intentos
const authDir = path.join(__dirname, "auth_info_baileys");

// Middleware de autenticación con Bearer Token
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

// Función para limpiar la sesión anterior
async function cleanupSession() {
  console.log("🧹 Limpiando sesión anterior...");

  if (sock) {
    try {
      // Desconectar socket si está activo
      sock.end();
      sock.removeAllListeners();
    } catch (error) {
      console.log("⚠️ Error al cerrar socket:", error.message);
    }
    sock = null;
  }

  // Limpiar directorio de autenticación solo si es necesario
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("📁 Directorio de autenticación eliminado");
    } catch (error) {
      console.log("⚠️ Error al eliminar directorio:", error.message);
    }
  }

  // Resetear variables
  qrCode = null;
  isAuthenticated = false;
  connectionStatus = "desconectado";
  isReconnecting = false;
}

// Función para reconectar con retry logic mejorado
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

    // Limpiar sesión para permitir nuevo QR
    await cleanupSession();

    // Notificar que se necesita un nuevo QR
    console.log("📱 Se requiere escanear nuevo código QR");
    setTimeout(() => {
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }, RECONNECT_DELAY);
    return;
  }

  // Esperar antes de reconectar (backoff exponencial)
  const delay = RECONNECT_DELAY * Math.min(reconnectAttempts, 3);
  console.log(`⏱️ Esperando ${delay / 1000} segundos antes de reconectar...`);

  setTimeout(() => {
    isReconnecting = false;
    if (shouldReconnect) {
      connectToWhatsApp();
    }
  }, delay);
}

async function connectToWhatsApp() {
  // Evitar múltiples conexiones simultáneas
  if (connectionStatus === "conectando" || connectionStatus === "conectado") {
    console.log("⚠️ Ya hay una conexión activa o en proceso");
    return;
  }

  console.log("🔄 Iniciando conexión con WhatsApp...");
  connectionStatus = "conectando";

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Verificar si hay credenciales guardadas
    const hasAuth = state.creds && state.creds.me;
    console.log("🔑 Credenciales existentes:", hasAuth ? "Sí" : "No");

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      retryRequestDelayMs: 250,
      connectTimeoutMs: 60000, // 60 segundos timeout
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      fireInitQueries: false,
    });

    // Manejo de eventos de la conexión
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Actualizar el QR code cuando se reciba
      if (qr) {
        qrCode = qr;
        isAuthenticated = false;
        connectionStatus = "esperando_qr";
        reconnectAttempts = 0; // Resetear contador cuando hay nuevo QR
        console.log("📱 Nuevo código QR generado");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output
          ?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConflict = statusCode === DisconnectReason.connectionReplaced;
        const isLost = statusCode === DisconnectReason.connectionLost;
        const isTimedOut = statusCode === DisconnectReason.timedOut;
        const isBadSession = statusCode === DisconnectReason.badSession;

        console.log("❌ Conexión cerrada");
        console.log("   Código de estado:", statusCode);
        console.log(
          "   Razón:",
          lastDisconnect?.error?.message || "Desconocida"
        );

        connectionStatus = "desconectado";
        isAuthenticated = false;
        qrCode = null;

        // Manejar diferentes tipos de desconexión
        if (isLoggedOut) {
          console.log("🔓 Sesión cerrada por el usuario. Limpiando...");
          reconnectAttempts = 0;
          await cleanupSession();

          // Esperar un poco antes de generar nuevo QR
          setTimeout(() => {
            if (shouldReconnect) {
              connectToWhatsApp();
            }
          }, 3000);
        } else if (isConflict) {
          console.log("⚠️ Sesión reemplazada en otro dispositivo");
          shouldReconnect = false; // No reconectar automáticamente
          await cleanupSession();
        } else if (isBadSession) {
          console.log("🔴 Sesión corrupta. Limpiando...");
          reconnectAttempts = 0;
          await cleanupSession();

          setTimeout(() => {
            if (shouldReconnect) {
              connectToWhatsApp();
            }
          }, 3000);
        } else if (isLost || isTimedOut) {
          console.log("📡 Conexión perdida. Intentando reconectar...");

          if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            await attemptReconnect();
          } else {
            console.log(
              "🛑 Reconexión deshabilitada o máximo de intentos alcanzado"
            );
          }
        } else {
          // Otros errores desconocidos
          console.log("⚠️ Error desconocido. Evaluando reconexión...");

          if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            await attemptReconnect();
          }
        }
      } else if (connection === "open") {
        connectionStatus = "conectado";
        isAuthenticated = true;
        qrCode = null;
        reconnectAttempts = 0; // Resetear contador al conectar exitosamente
        isReconnecting = false;

        console.log("✅ ¡Conectado a WhatsApp exitosamente!");
        console.log("📱 Número:", sock.user?.id);
        console.log("👤 Nombre:", sock.user?.name || "No disponible");
      } else if (connection === "connecting") {
        connectionStatus = "conectando";
        console.log("🔄 Conectando a WhatsApp...");
      }
    });

    // Guardar credenciales de sesión
    sock.ev.on("creds.update", saveCreds);

    // Manejar errores del socket
    sock.ev.on("error", (error) => {
      console.error("❌ Error en el socket:", error);
      connectionStatus = "error";
    });
  } catch (error) {
    console.error("❌ Error al conectar:", error);
    connectionStatus = "error";
    isReconnecting = false;

    // Solo intentar reconectar si está habilitado y no se han excedido los intentos
    if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await attemptReconnect();
    }
  }
}

// --- ENDPOINTS DE LA API ---
app.get("/", (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  res.send(`
            <h1>✅ API de WhatsApp</h1>
            <p><b>Estado:</b> ${connectionStatus}</p>
            <p><b>Autenticado:</b> ${isAuthenticated ? "Sí" : "No"}</p>
            <p><b>Tiempo activo:</b> ${hours}h ${minutes}m</p>
            <p><b>Reconexión automática:</b> ${
              shouldReconnect ? "Habilitada" : "Deshabilitada"
            }</p>
        `);
});

// Endpoint de estado detallado
app.get("/estado", authenticate, (req, res) => {
  res.status(200).json({
    status: connectionStatus,
    isAuthenticated: isAuthenticated,
    hasQR: !!qrCode,
    reconnectAttempts: reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    shouldReconnect: shouldReconnect,
    isReconnecting: isReconnecting,
    user: sock?.user || null,
    uptime: process.uptime(),
  });
});

// Endpoint QR con autenticación
app.get("/qr", authenticate, (req, res) => {
  if (qrCode) {
    res.type("text/plain").send(qrCode);
  } else if (isAuthenticated) {
    res.status(200).json({
      message: "Ya está autenticado. No se necesita QR.",
      status: connectionStatus,
      user: sock?.user?.id,
    });
  } else if (connectionStatus === "conectando") {
    res.status(200).json({
      message: "Conectando... Espere un momento para el QR.",
      status: connectionStatus,
    });
  } else if (connectionStatus === "error_reconexion") {
    res.status(200).json({
      message:
        "Se requiere reconexión manual. Use /reconectar para generar nuevo QR.",
      status: connectionStatus,
    });
  } else {
    res.status(200).json({
      message: "QR no disponible. Puede que necesite reiniciar la sesión.",
      status: connectionStatus,
    });
  }
});

// Endpoint para enviar mensajes
app.post("/enviar", authenticate, async (req, res) => {
  if (connectionStatus !== "conectado" || !isAuthenticated) {
    return res.status(400).json({
      error: "WhatsApp no está conectado. No se puede enviar el mensaje.",
      status: connectionStatus,
      isAuthenticated: isAuthenticated,
    });
  }

  const { number, message } = req.body;
  if (!number || !message) {
    return res
      .status(400)
      .json({ error: "El `number` y el `message` son requeridos." });
  }

  try {
    const clientIp = req.ip;
    console.log(`[LOG] Envío desde IP: ${clientIp} | Número: ${number}`);

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });

    res.status(200).json({
      status: "éxito",
      message: "Mensaje enviado correctamente.",
      to: number,
    });
  } catch (error) {
    console.error("Error enviando mensaje:", error);
    res.status(500).json({ error: "Error interno al enviar el mensaje." });
  }
});

// Endpoint para forzar reconexión
app.post("/reconectar", authenticate, async (req, res) => {
  console.log("🔄 Reconexión manual solicitada");

  shouldReconnect = true;
  reconnectAttempts = 0;
  isReconnecting = false;

  await cleanupSession();

  res.status(200).json({
    status: "éxito",
    message: "Sesión limpiada. Generando nuevo QR en 2 segundos...",
  });

  setTimeout(connectToWhatsApp, 2000);
});

// Endpoint para desconectar (sin reconexión automática)
app.post("/desconectar", authenticate, async (req, res) => {
  console.log("🛑 Desconexión solicitada");

  shouldReconnect = false; // Deshabilitar reconexión automática

  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      console.log("Error al hacer logout:", error.message);
    }

    await cleanupSession();

    res.status(200).json({
      status: "éxito",
      message: "Sesión cerrada. Reconexión automática deshabilitada.",
    });
  } else {
    res.status(400).json({
      error: "No hay una sesión activa para cerrar.",
      status: connectionStatus,
    });
  }
});

// Endpoint para habilitar/deshabilitar reconexión automática
app.post("/configurar-reconexion", authenticate, (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({
      error: 'El parámetro "enabled" debe ser true o false',
    });
  }

  shouldReconnect = enabled;

  res.status(200).json({
    status: "éxito",
    message: `Reconexión automática ${
      enabled ? "habilitada" : "deshabilitada"
    }`,
    shouldReconnect: shouldReconnect,
  });
});

// Endpoint para enviar imagen desde una URL
app.post("/enviar-imagen-url", authenticate, async (req, res) => {
  // Primero, verifica si el cliente de WhatsApp está conectado
  if (connectionStatus !== "conectado" || !isAuthenticated) {
    return res.status(400).json({
      error: "WhatsApp no está conectado. No se puede enviar la imagen.",
      status: connectionStatus,
      isAuthenticated: isAuthenticated,
    });
  }

  // Extrae los datos del cuerpo de la solicitud
  const { number, imageUrl, caption } = req.body;

  // Valida que los campos necesarios estén presentes
  if (!number || !imageUrl) {
    return res
      .status(400)
      .json({ error: "Los campos `number` y `imageUrl` son requeridos." });
  }

  try {
    // Formatea el número de teléfono al formato JID de WhatsApp
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;

    console.log(`[LOG] Enviando imagen desde URL: ${imageUrl} a ${number}`);

    // Prepara el objeto del mensaje para Baileys
    // La clave 'image' le dice a Baileys que es una imagen,
    // y la propiedad 'url' le indica de dónde descargarla.
    const messageData = {
      image: { url: imageUrl },
      caption: caption || "", // Añade un pie de foto (caption) si se proporciona
    };

    // Envía el mensaje usando el socket
    await sock.sendMessage(jid, messageData);

    // Responde con éxito
    res.status(200).json({
      status: "éxito",
      message: "Imagen enviada correctamente.",
      to: number,
    });
  } catch (error) {
    console.error("Error enviando imagen desde URL:", error);
    res.status(500).json({ error: "Error interno al enviar la imagen." });
  }
});

// Endpoint de salud para monitoreo
app.get("/health", (req, res) => {
  const memory = process.memoryUsage();
  const uptime = process.uptime();

  res.status(200).json({
    status: "online",
    connection: connectionStatus,
    authenticated: isAuthenticated,
    uptime: {
      seconds: uptime,
      formatted: `${Math.floor(uptime / 3600)}h ${Math.floor(
        (uptime % 3600) / 60
      )}m`,
    },
    memory: {
      used: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
      total: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
    },
    reconnection: {
      enabled: shouldReconnect,
      attempts: reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      isReconnecting: isReconnecting,
    },
    timestamp: new Date().toISOString(),
  });
});

// Manejo de errores no capturados
process.on("uncaughtException", (error) => {
  console.error("❌ Error no capturado:", error);
  // No cerrar el proceso, intentar recuperarse
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promesa rechazada no manejada:", reason);
  // No cerrar el proceso, intentar recuperarse
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("📛 SIGTERM recibido. Cerrando conexiones...");
  shouldReconnect = false;

  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      console.log("Error durante shutdown:", error.message);
    }
  }

  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("\n📛 SIGINT recibido. Cerrando conexiones...");
  shouldReconnect = false;

  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      console.log("Error durante shutdown:", error.message);
    }
  }

  process.exit(0);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║     API WhatsApp - Servidor Iniciado       ║");
  console.log("╠════════════════════════════════════════════╣");
  console.log(`║ 🚀 Puerto: ${PORT.toString().padEnd(33)}║`);
  console.log(
    `║ 🔒 Token: ${(BEARER_TOKEN ? "Configurado" : "⚠️ NO CONFIGURADO").padEnd(
      34
    )}║`
  );
  console.log(`║ 🔄 Reconexión: ${"Habilitada".padEnd(29)}║`);
  console.log(`║ 📱 Estado: ${"Inicializando...".padEnd(33)}║`);
  console.log("╚════════════════════════════════════════════╝");

  // Iniciar conexión con WhatsApp
  connectToWhatsApp();
});
