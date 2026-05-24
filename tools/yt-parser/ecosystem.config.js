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
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      time: true,
      max_restarts: 10,
      min_uptime: "30s",
    },
  ],
};
