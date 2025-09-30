// config.js
module.exports = {
  LOG_FILE_PATH: require('path').join(__dirname, 'logs', 'http-to-tcp.log'),

  // 👇 This is the list the UI/endpoint uses
  servers: [
    { name: 'Vantage', host: '10.101.111.70', port: 3040 },
  ],

  // optional
  HANDSHAKE: 'VCL 1 0\r\n',
  debug: {
    push: false   // set to true to enable verbose push logs
  }
  
};
