FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json* ./
COPY vite.config.ts ./

# Copy source separately to leverage caching
COPY public ./public
COPY src ./src

ARG VITE_API_URL=http://localhost:3000/api
ENV VITE_API_URL=${VITE_API_URL}

RUN npm ci && npm run build

FROM nginx:1.27-alpine
COPY --from=base /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
