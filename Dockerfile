# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy source files
COPY . .

# Build static files (uses bunx vite, no npm deps needed)
RUN bun run build

# Production stage - serve with nginx
FROM nginx:alpine

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
