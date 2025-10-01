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
  },

	// Optional: explicitly pin where to find Homebridge's config.json
	exports.HB_CONFIG_PATH = process.env.HB_CONFIG_PATH || null;
	
	// Optional: extra places to look
	// $HOME entry is computed in app.js with os.homedir()
	exports.HB_CONFIG_CANDIDATES = [
	  '/var/lib/homebridge/config.json'
	];

};
