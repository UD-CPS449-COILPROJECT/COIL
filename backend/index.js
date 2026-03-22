import { createApp } from './src/app.js';

const app = createApp();
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('HTTP server with Express.js listening on port ' + port));
