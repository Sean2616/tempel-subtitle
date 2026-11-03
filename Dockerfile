FROM node:20-slim

# Install FFmpeg dan Font agar Hard Subtitle muncul di server Linux
RUN apt-get update && \
    apt-get install -y ffmpeg fonts-liberation fontconfig && \
    fc-cache -f -v && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Buat folder sementara dan buka izin akses tulis
RUN mkdir -p uploads outputs && chmod 777 uploads outputs

# Port default untuk Cloud / Hugging Face / Render
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]