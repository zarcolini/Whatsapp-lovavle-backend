# ==============================================================================
# 1. Imagen Base: Usamos Node.js 18 (LTS) sobre una base slim.
# ==============================================================================
FROM node:18-slim

# ==============================================================================
# 2. Instalar Dependencias del Sistema para Chrome (Puppeteer)
# Estas son las librerías .so que faltaban en tu log de error.
# También instalamos 'chromium' directamente desde apt.
# ==============================================================================
RUN apt-get update && apt-get install -y \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libdbus-1-3 \
    libxcomposite1 \
    libasound2 \
    libatspi2.0-0 \
    libx11-6 \
    libxext6 \
    libxss1 \
    --no-install-recommends \
    # Limpiar caché de apt para mantener la imagen ligera
    && rm -rf /var/lib/apt/lists/*

# ==============================================================================
# 3. Configurar Entorno de la App
# ==============================================================================
WORKDIR /app

# Le decimos a Puppeteer que use el binario de Chromium que instalamos con apt
# y que no intente descargar su propia versión.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copiar archivos de dependencias
COPY package.json package-lock.json* ./

# ==============================================================================
# 4. Instalar Dependencias de Node.js
# Usamos --omit=dev para no instalar dependencias de desarrollo (ej. nodemon)
# ==============================================================================
RUN npm install --omit=dev --no-fund --no-audit

# ==============================================================================
# 5. Copiar el Código de la Aplicación
# ==============================================================================
COPY . .

# ==============================================================================
# 6. Exponer Puerto y Ejecutar
# Railway define la variable $PORT (usualmente 8080), 
# tu código ya la usa (process.env.PORT || 3000), así que esto es perfecto.
# No es necesario EXPOSE explícitamente para Railway, pero es buena práctica.
#
# *** ESTA ES LA LÍNEA CORREGIDA ***
# ==============================================================================
CMD [ "node", "server.js" ]
