import express, { Request, Response } from 'express';
import http from 'http';
import 'dotenv/config';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import {
  Worker,
  Router,
  RtpCodecCapability,
  WebRtcTransportOptions,
  Producer,
  AppData,
  Consumer,
  WebRtcTransport,
} from 'mediasoup/node/lib/types';

const PORT = process.env.PORT || 3004;
const IP = process.env.IP || '127.0.0.1';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || null;

const startServer = async () => {
  const app = express();
  const httpServer = http.createServer(app);

  app.get('/', (req: Request, res: Response) => {
    res.send('WORKING!');
  });

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const peers = io.of('/mediasoup');

  let worker: Worker;
  let router: Router;
  let producerTransport: WebRtcTransport<AppData> | undefined;
  let consumerTransport: WebRtcTransport<AppData> | undefined;
  let producer: Producer<AppData>;
  let consumer: Consumer;

  const createWorker = async () => {
    worker = await mediasoup.createWorker({
      rtcMinPort: 2000,
      rtcMaxPort: 2020,
    });
    console.log(`worker pid ${worker.pid}`);

    worker.on('died', (error: any) => {
      console.error('mediasoup worker has passed away 😔', '\n', error);
      setTimeout(() => process.exit(1), 2000); // MURDER whole service after 2 secs
    });

    return worker;
  };

  worker = await createWorker();

  const mediaCodecs: RtpCodecCapability[] = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
  ];

  peers.on('connection', async (socket) => {
    console.log('user-connected');
    router = await worker.createRouter({ mediaCodecs });

    peers.emit('connection-success', { socketId: socket.id });

    socket.on('disconnect', () => {
      console.log('peer disconnected!');
    });

    socket.on('getRtpCapabilities', () => {
      const rtpCapabilitiesData = router.rtpCapabilities;
      socket.emit('sendRtpCapabilities', { rtpCapabilitiesData });
      console.log('Router RTP Capabilities: ', rtpCapabilitiesData);
    });

    socket.on('createWebRtcTransport', async ({ sender }, callback) => {
      console.log(`is this a sender request? ${sender}`);

      if (sender) {
        // create producer
        producerTransport = await createWebRtcTransport(callback);
      } else {
        // create consumer
        consumerTransport = await createWebRtcTransport(callback);
      }
    });

    socket.on('transport-connect', async ({ dtlsParameters }) => {
      console.log('DTLS PARAMS: ', dtlsParameters);

      if (!producerTransport) {
        console.error('producerTransport has not been decalred!');
        return;
      }

      await producerTransport.connect({ dtlsParameters });
    });

    socket.on('transport-produce', async ({ kind, rtpParameters, appdata }, callback) => {
      if (!producerTransport) {
        console.error('Producer has not been defined');
        return;
      }
      producer = await producerTransport.produce({ kind, rtpParameters });

      console.log('Producer ID: ', producer.id, producer.kind);

      producer.on('transportclose', () => {
        console.log('transport for this producer has closed!');
        producer.close();
      });

      callback({ id: producer.id });
    });

    socket.on('transport-recv-connect', async ({ dtlsParameters, transportId }) => {
      if (!consumerTransport) {
        console.error('consumerTransport has not been defined');
        return;
      }
      console.log('DTLS PARAMS: ', dtlsParameters);
      console.log('transport Id: ', transportId);
      await consumerTransport.connect({ dtlsParameters });
    });

    socket.on('consume', async ({ rtpCapabilities }, callback) => {
      if (!consumerTransport) {
        console.error('consumerTransport has not been defined');
        return;
      }
      try {
        if (
          router.canConsume({
            producerId: producer.id,
            rtpCapabilities,
          })
        ) {
          consumer = await consumerTransport.consume({
            producerId: producer.id,
            rtpCapabilities,
            paused: true,
          });
          consumer.on('transportclose', () => {
            console.log('transport close from consumer');
          });

          const params = {
            id: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          };

          callback({ params });
        }
      } catch (error) {
        console.error(error);
        callback({
          params: {
            error: (error as Error).message,
          },
        });
      }
    });

    socket.on('consumer-resume', async () => {
      console.log('consumer resuming');
      await consumer.resume();
    });
  });

  const createWebRtcTransport = async (callback: ({}: any) => void) => {
    try {
      const transportOptions: WebRtcTransportOptions = {
        listenIps: [{ ip: IP, ...(ANNOUNCED_IP && { announcedIp: ANNOUNCED_IP }) }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      let transport = await router.createWebRtcTransport(transportOptions);

      console.log('transport id: ', transport.id);
      transport.on('dtlsstatechange', (dtlsstate) => {
        if (dtlsstate === 'closed') {
          transport.close();
        }
      });

      transport.on('icestatechange', (iceState) => {
        console.log('ICE STATE: ', iceState);
      });

      transport.on('@close', () => {
        console.log('transport closed!');
      });

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });

      return transport;
    } catch (error) {
      console.log(error);
      callback({
        params: {
          error: error,
        },
      });
    }
  };
};

startServer();
