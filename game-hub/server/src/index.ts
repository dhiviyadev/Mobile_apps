/** Server entry point. */
import { config } from './config';
import { createGameServer } from './app';
import { logger } from './log';

const log = logger('server');
const server = createGameServer();
await server.listen(config.port, config.host);
log.info(`listening on ws://${config.host}:${config.port}`);
