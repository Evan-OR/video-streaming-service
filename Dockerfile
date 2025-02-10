FROM node:17-alpine3.12

COPY . /app
COPY package.json .
COPY package-lock.json .

RUN apk add g++ make python3 linux-headers
RUN apk add --update py3-pip
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.1.2/zsh-in-docker.sh)"

ENV PORT=3000

RUN npm install

CMD [ "node", "index.js" ]