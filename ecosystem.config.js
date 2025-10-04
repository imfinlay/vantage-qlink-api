module.exports = {
  apps: [
    {
      name: "vantage-qlink-api",
      script: "src/index.js",
      cwd: process.cwd(),
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
}
