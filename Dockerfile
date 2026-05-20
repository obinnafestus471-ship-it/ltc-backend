FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV SUPABASE_URL=https://pccuhtlfnfvyitioobko.supabase.co
ENV SUPABASE_KEY=sb_secret_s1MTGOjGESnYg8NyFR9S6g_FHbOGHTK
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
