# Usamos a imagem oficial do Node.js
FROM node:18

# Instalamos o ffmpeg (necessário para transcodificação)
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Criamos a pasta do app
WORKDIR /app

# Copiamos os ficheiros de dependências
COPY package*.json ./

# Instalamos as bibliotecas
RUN npm install

# Copiamos o resto do código
COPY . .

# Expomos a porta que o Hugging Face usa por defeito (7860)
EXPOSE 7860

# Comando para ligar o teu servidor
CMD ["node", "server.cjs"]
