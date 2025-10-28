const app = require('./app');
const http = require('http');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 5000;

http.createServer(app).listen(PORT, () => {
    console.log(`API running http://localhost:${PORT}`);
});
