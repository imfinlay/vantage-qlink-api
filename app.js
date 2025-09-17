const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
const path = require('path');
const config = require('./config');

const LOG_FILE_PATH = config.LOG_FILE_PATH;

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

let VALID_COMMANDS = {};
let commandLog = [];

function loadValidCommandsFromCSV(filePath) {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n');

    lines.forEach((line) => {
        const parts = line.match(/(?:[^,"']+|"(?:\\.|[^"])*")+/g); // Match CSV fields, considering quoted strings
        if (parts && parts.length >= 3) {
            const command = parts[0].trim();
            const description = parts[1].trim().replace(/^"|"$/g, ''); // Remove double quotes
            const params = parts.slice(2).join(',').trim(); // Combine and trim remaining parts as parameters

            VALID_COMMANDS[command] = {
                description,
                params: parseParams(params),
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

const servers = config.servers;

let tcpClient = null;
let responseCallbacks = [];

function validateCommand(input) {
    const regex = /^([A-Z]{3})([!@#])?(.*)?$/; // Regex to match the command and optional modifier
    const match = input.match(regex);

    if (!match) {
        return { valid: false, statusCode: 400, message: `Invalid command format.` };
    }

    const command = match[1];
    const modifier = match[2] || ''; // Default to no modifier if no modifier provided
    const paramString = match[3]?.trim() || '';
    const params = paramString.split(' ').filter(Boolean);

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

    return { valid: true, command, modifier, params };
}

function logCommand(message, response) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} - Command: ${message}, Response: ${response}\n`;
    commandLog.unshift({ timestamp, message, response });
    fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf8');
}

// Endpoint to retrieve the list of available servers
app.get('/servers', (req, res) => {
    res.json(servers);
});

// Endpoint to retrieve a list of valid commands and their descriptions
app.get('/commands', (req, res) => {
    const commands = Object.keys(VALID_COMMANDS).map((cmd) => ({
        command: cmd,
        description: VALID_COMMANDS[cmd].description,
    }));
    res.json(commands);
});

// Endpoint to retrieve logs of executed commands and responses
app.get('/logs', (req, res) => {
    const formattedLogs = commandLog.map(log => ({
        ...log,
        response: `${log.response}`
    }));
    res.json(formattedLogs);
});

// Endpoint to connect to a specified TCP server
app.post('/connect', (req, res) => {
    const { serverIndex } = req.body;

    if (serverIndex < 0 || serverIndex >= servers.length) {
        return res.status(400).json({ message: 'Invalid server index.' });
    }

    const { host, port } = servers[serverIndex];

    tcpClient = new net.Socket();

    tcpClient.connect(port, host, () => {
        tcpClient.write("VCL 1 0\r\n"); // Set response termination to CRLF
        res.json({ message: `Connected to ${servers[serverIndex].name}.` });
    });

    tcpClient.on('data', (data) => {
        const response = data.toString().split(/\r?\n/).filter(line => line.trim() !== ''); // Handle CRLF-delimited responses
        if (responseCallbacks.length > 0) {
            const callback = responseCallbacks.shift();
            callback(response.join(' ')); // Concatenate multiline response into one string
        }
    });

    tcpClient.on('close', () => {
        tcpClient = null;
    });

    tcpClient.on('error', (err) => {
        res.status(500).json({ message: 'Failed to connect to the server.' });
    });
});

// Endpoint to disconnect from the TCP server
app.post('/disconnect', (req, res) => {
    if (tcpClient) {
        tcpClient.destroy();
        tcpClient = null;
        res.json({ message: 'Disconnected from TCP server.' });
    } else {
        res.status(400).json({ message: 'Not connected to any TCP server.' });
    }
});

// Endpoint to send a command to the TCP server
app.post('/send', (req, res) => {
    const { message } = req.body;

    if (!tcpClient) {
        return res.status(400).json({ message: 'Not connected to any TCP server.' });
    }

    const validation = validateCommand(message);
    if (!validation.valid) {
        return res.status(validation.statusCode).json({ message: validation.message });
    }

    const { command, modifier, params } = validation;
    const formattedMessage = `${command}${modifier} ${params.join(' ')}\r`;
    tcpClient.write(formattedMessage);

    responseCallbacks.push((response) => {
        logCommand(message, response);

        // Parse space-delimited response
        const parsedResponse = response.trim().split(/\s+/);

        res.json({
            message: `Message: ${message}`,
            response: parsedResponse, // Return parsed response as an array
        });
    });
});



// Start the server and listen on port 3000
app.listen(3000, () => {
    console.log('HTTP to TCP API is running on port 3000.');
});

// --- Optional: semantic wrappers for HomeKit/Homebridge-style calls ---
// These routes DO NOT replace /send. They provide friendly endpoints and
// internally build the ASCII command using a simple template map.
// If ./semantic.json exists, we'll use it; otherwise these routes return 400.

let semantic = null;
try {
  semantic = require('./semantic.json');
  // Expected shape:
  // {
  //   "lights": {
  //     "Kitchen": {
  //       "on": "VLA <id> 1 100",
  //       "off": "VLA <id> 0 0",
  //       "level": "VLA <id> 1 <value>",
  //       "id": "L01" // optional fixed ID
  //     }
  //   },
  //   "tvs": {
  //     "FamilyRoom": { "on": "TVP <id> 1", "off": "TVP <id> 0", "id": "TV1" }
  //   }
  // }
} catch (_) {
  semantic = null; // optional file
}

function formatTemplate(tpl, ctx) {
  return tpl
    .replace(/<id>/g, ctx.id)
    .replace(/<value>/g, String(ctx.value ?? ''))
    .trim();
}

// Promise-based helper that reuses your validator + response queue
function sendAndAwait(message) {
  return new Promise((resolve, reject) => {
    if (!tcpClient) return reject(new Error('Not connected to any TCP server.'));
    const validation = validateCommand(message);
    if (!validation.valid) {
      const err = new Error(validation.message);
      err.code = validation.statusCode;
      return reject(err);
    }
    const { command, modifier, params } = validation;
    const formattedMessage = `${command}${modifier} ${params.join(' ')}\r`;
    tcpClient.write(formattedMessage);

    responseCallbacks.push((response) => {
      logCommand(message, response);
      const parsedResponse = response.trim().split(/\s+/);
      resolve({ message: `Message: ${message}`, response: parsedResponse });
    });
  });
}

// Lights
app.post('/lights/:name/on', async (req, res) => {
  try {
    if (!semantic?.lights?.[req.params.name]?.on) {
      return res.status(400).json({ message: 'No template for this light/on. Add to semantic.json.' });
    }
    const id = semantic.lights[req.params.name].id || req.params.name;
    const cmd = formatTemplate(semantic.lights[req.params.name].on, { id });
    res.json(await sendAndAwait(cmd));
  } catch (e) { res.status(e.code || 500).json({ message: e.message || 'Failed' }); }
});

app.post('/lights/:name/off', async (req, res) => {
  try {
    if (!semantic?.lights?.[req.params.name]?.off) {
      return res.status(400).json({ message: 'No template for this light/off. Add to semantic.json.' });
    }
    const id = semantic.lights[req.params.name].id || req.params.name;
    const cmd = formatTemplate(semantic.lights[req.params.name].off, { id });
    res.json(await sendAndAwait(cmd));
  } catch (e) { res.status(e.code || 500).json({ message: e.message || 'Failed' }); }
});

app.post('/lights/:name/level', async (req, res) => {
  try {
    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return res.status(400).json({ message: 'value must be 0..100' });
    }
    if (!semantic?.lights?.[req.params.name]?.level) {
      return res.status(400).json({ message: 'No template for this light/level. Add to semantic.json.' });
    }
    const id = semantic.lights[req.params.name].id || req.params.name;
    const cmd = formatTemplate(semantic.lights[req.params.name].level, { id, value });
    res.json(await sendAndAwait(cmd));
  } catch (e) { res.status(e.code || 500).json({ message: e.message || 'Failed' }); }
});

// TVs
app.post('/tvs/:name/on', async (req, res) => {
  try {
    if (!semantic?.tvs?.[req.params.name]?.on) {
      return res.status(400).json({ message: 'No template for this tv/on. Add to semantic.json.' });
    }
    const id = semantic.tvs[req.params.name].id || req.params.name;
    const cmd = formatTemplate(semantic.tvs[req.params.name].on, { id });
    res.json(await sendAndAwait(cmd));
  } catch (e) { res.status(e.code || 500).json({ message: e.message || 'Failed' }); }
});

app.post('/tvs/:name/off', async (req, res) => {
  try {
    if (!semantic?.tvs?.[req.params.name]?.off) {
      return res.status(400).json({ message: 'No template for this tv/off. Add to semantic.json.' });
    }
    const id = semantic.tvs[req.params.name].id || req.params.name;
    const cmd = formatTemplate(semantic.tvs[req.params.name].off, { id });
    res.json(await sendAndAwait(cmd));
  } catch (e) { res.status(e.code || 500).json({ message: e.message || 'Failed' }); }
});
