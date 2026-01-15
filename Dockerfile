# ==============================================================================
# 1. Imagen Base: Node.js 20 (LTS) sobre una base slim
# Baileys requiere Node.js 20+ para funcionar correctamente
# ==============================================================================
FROM node:20-slim

# ==============================================================================
# 2. Configurar Entorno de la App
# ==============================================================================
WORKDIR /app

# Copiar archivos de dependencias
COPY package.json package-lock.json* ./

# ==============================================================================
# 3. Instalar Dependencias de Node.js
# Usamos --omit=dev para no instalar dependencias de desarrollo (ej. nodemon)
# ==============================================================================
RUN npm install --omit=dev --no-fund --no-audit

# ==============================================================================
# 4. Copiar el Código de la Aplicación
# ==============================================================================
COPY . .

# ==============================================================================
# 5. Exponer Puerto y Ejecutar
# Railway define la variable $PORT (usualmente 8080),
# tu código ya la usa (process.env.PORT || 3000)
# ==============================================================================
CMD [ "node", "server.js" ]
