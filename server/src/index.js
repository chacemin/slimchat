// Compatibility entry for tests and embedders that used worker/src/index.js.
export { app, siteFetch } from './app.js';
import { siteFetch as fetchHandler } from './app.js';
export default { fetch: fetchHandler };
