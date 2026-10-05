import 'dotenv/config';
import { createApp } from './app.js';
const service = createApp();
const port = Number(process.env.PORT || 3001);
service.http.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`WebRTC server: http://${process.env.HOST || '127.0.0.1'}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.close(); process.exit(0); });
