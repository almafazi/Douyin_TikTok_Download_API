module.exports = {
  apps: [
    {
      name: 'tiktok-telegram-bot',
      script: './bot.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },
      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Restart policy
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      // Auto restart on failure
      autorestart: true,
      // Memory limit
      max_memory_restart: '512M',
      // Watch mode (disable in production)
      watch: false,
      // Ignore files for watch mode
      ignore_watch: ['node_modules', 'logs', '.git'],
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Merge logs
      merge_logs: true,
      // Disable PM2 daemon logs
      pmx: false,
      // Cron restart (optional - restart daily at 4 AM)
      // cron_restart: '0 4 * * *',
    }
  ]
};
