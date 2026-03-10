import express from 'express';
import cors from 'cors';

const app = express();
var port = process.env.PORT || 8080;
app.use(express.urlencoded({extended: false}));
app.use(cors());

app.listen(port, () => console.log('HTTP server with Express.js listening on port ' + port));

app.get('/', (req, res) => {
    res.send('Microservice Gateway\nVersion: 0.0.1');
});
