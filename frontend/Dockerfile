# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Add .mjs MIME type to nginx mime.types if not already present
RUN grep -q "application/javascript.*mjs" /etc/nginx/mime.types || \
    sed -i '/application\/javascript/s/js;/js mjs;/' /etc/nginx/mime.types

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
