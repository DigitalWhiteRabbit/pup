module.exports = {
  apps: [
    {
      name: "yt-parser",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      exec_mode: "fork",
      max_memory_restart: "1200M",
      env: {
        NODE_ENV: "production",
        // Pin the port here, not via .env: deploy.sh spawns yt-parser from a
        // context where dotenv skips PORT (it's pre-set), so server.js would
        // fall back to its default 3000 and clash with pup. pm2 env wins.
        PORT: "3001",
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      time: true,
      max_restarts: 10,
      min_uptime: "30s",
    },
  ],
};
