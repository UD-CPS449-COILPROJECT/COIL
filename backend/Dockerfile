FROM node:22-alpine

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Copy app source
COPY . .

RUN echo "Creating a docker image by mooreb26@udayton.edu"
EXPOSE 8080
CMD ["npm", "start"]
