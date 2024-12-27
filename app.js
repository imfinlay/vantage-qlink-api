const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
const path = require('path');

const LOG_FILE_PATH = '/var/log/vantage-qlink-api.log';

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

let VALID_COMMANDS = {};
let commandLog = [];

function loadValidCommandsFromCSV(filePath) {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n');

    lines.forEach((line) => {
        const [command, description, params] = line.split(',');
        if (command && description && params) {
            VALID_COMMANDS[command.trim()] = {
                description: description.trim(),
                params: parseParams(params.trim()),
            };
        }
    });
}

function parseParams(paramString) {
    if (paramString === "<none>") return { count: 0, type: null };

    const paramCount = (paramString.match(/</g) || []).length;
    let type = null;

    if (paramString.includes("number")) type = "number";
    if (paramString.includes("string")) type = "string";

    return { count: paramCount, type };
}

loadValidCommandsFromCSV('./commands.csv');

const servers = [
    { name: "Server 1", host: "127.0.0.1", port: 4000 },
    { name: "Vantage", host: "10.101.111.70", port: 3040 },
];

let tcpClient = null;
let responseCallbacks = [];

function validateCommand(input) {
    const [command, ...params] = input.split(' ');
    const rule = VALID_COMMANDS[command];

    if (!rule) {
        return { valid: false, statusCode: 400, message: `Invalid command: ${command}` };
    }

    if (params.length !== rule.params.count) {
        return {
            valid: false,
            statusCode: 422,
            message: `Invalid number of parameters for command: ${command}. Expected ${rule.params.count}, got ${params.length}.`,
        };
    }

    if (rule.params.type === "number" && params.some((p) => isNaN(parseFloat(p)))) {
        return { valid: false, statusCode: 422, message: `Parameters for ${command} must be numeric.` };
    }

    if (rule.params.type === "string" && params.some((p) => typeof p !== "string")) {
        return { valid: false, statusCode: 422, message: `Parameters for ${command} must be strings.` };
    }

    return { valid: true };
}

function logCommand(message, response) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} - Command: ${message}, Response: ${response}\n`;
    commandLog.unshift({ timestamp, message, response });
    fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf8');
}

app.get('/servers', (req, res) => {
    res.json(servers);
});

app.get('/commands', (req, res) => {
    const commands = Object.keys(VALID_COMMANDS).map((cmd) => ({
        command: cmd,
        description: VALID_COMMANDS[cmd].description,
    }));
    res.json(commands);
});

app.get('/logs', (req, res) => {
    res.json(commandLog);
});

app.post('/connect', (req, res) => {
    const { serverIndex } = req.body;

    if (serverIndex < 0 || serverIndex >= servers.length) {
        return res.status(400).json({ message: 'Invalid server index.' });
    }

    const { host, port } = servers[serverIndex];

    tcpClient = new net.Socket();

    tcpClient.connect(port, host, () => {
        res.json({ message: `Connected to ${servers[serverIndex].name}.` });
    });

    tcpClient.on('data', (data) => {
        const response = data.toString();
        if (responseCallbacks.length > 0) {
            const callback = responseCallbacks.shift();
            callback(response);
        }
    });

    tcpClient.on('close', () => {
        tcpClient = null;
    });

    tcpClient.on('error', (err) => {
        res.status(500).json({ message: 'Failed to connect to the server.' });
    });
});

app.post('/disconnect', (req, res) => {
    if (tcpClient) {
        tcpClient.destroy();
        tcpClient = null;
        res.json({ message: 'Disconnected from TCP server.' });
    } else {
        res.status(400).json({ message: 'Not connected to any TCP server.' });
    }
});

app.post('/send', (req, res) => {
    const { message } = req.body;

    if (!tcpClient) {
        return res.status(400).json({ message: 'Not connected to any TCP server.' });
    }

    const validation = validateCommand(message);
    if (!validation.valid) {
        return res.status(validation.statusCode).json({ message: validation.message });
    }

    const messageWithCR = `${message.toUpperCase()}\r`;
    tcpClient.write(messageWithCR);

    responseCallbacks.push((response) => {
        logCommand(message, response);
        res.json({ message: `Message: ${message}`, response: `Response: ${response}` });
    });
});

app.listen(3000, () => {
    console.log('HTTP to TCP API is running on port 3000.');
});

