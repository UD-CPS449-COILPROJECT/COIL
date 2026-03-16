import express from 'express';
import cors from 'cors';

const app = express();
var port = process.env.PORT || 8080;
app.use(express.urlencoded({extended: false}));
app.use(cors());
app.use(express.json());

app.listen(port, () => console.log('HTTP server with Express.js listening on port ' + port));

app.get('/', (req, res) => {
    res.send('Microservice Gateway\nVersion: 0.0.1');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running' });
});

app.post('/analyze', (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text input is required' });
    }

    let result = 'unknown request';

    if (text.toLowerCase().includes('deposit')) {
        result = 'deposit request';
    } else if (text.toLowerCase().includes('withdraw')) {
        result = 'withdraw request';
    } else if (text.toLowerCase().includes('transfer')) {
        result = 'transfer request';
    } else if (text.toLowerCase().includes('balance')) {
        result = 'balance inquiry';
    }

    res.json({
        input: text,
        prediction: result
    });
});
