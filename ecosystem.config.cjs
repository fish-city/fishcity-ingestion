// PM2 Ecosystem Config — Fish City Ingestion Engine
// Run: pm2 start ecosystem.config.cjs
// Monitor: pm2 logs | pm2 monit
// Stop: pm2 stop all | pm2 delete all

module.exports = {
  apps: [
    // ── Fishing Report Ingestion (3x daily: 6am, 12pm, 6pm) ──────────────
    {
      name: "fc-report-ingestion",
      script: "pipelines/fishing_reports/push.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "0 6,12,18 * * *",
      autorestart: false,          // Only run on cron, don't restart on exit
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "development"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/report-ingestion-error.log",
      out_file: "logs/report-ingestion-out.log",
      merge_logs: true,
      max_size: "10M",             // Rotate logs at 10MB
      retain: 5                    // Keep 5 rotated log files
    },

    // ── El Dorado Partner Notifications (hourly, 7am–9pm) ─────────────────
    {
      name: "fc-eldorado-notify",
      script: "pipelines/partner_schedules/eldorado_ingest.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "0 7-21 * * *",
      autorestart: false,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "development"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/eldorado-notify-error.log",
      out_file: "logs/eldorado-notify-out.log",
      merge_logs: true,
      max_size: "10M",
      retain: 5
    },

    // ── El Patron Partner Notifications (hourly, 7am–9pm, offset :15) ─────
    {
      name: "fc-elpatron-notify",
      script: "pipelines/partner_schedules/elpatron_ingest.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "15 7-21 * * *",
      autorestart: false,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "development"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/elpatron-notify-error.log",
      out_file: "logs/elpatron-notify-out.log",
      merge_logs: true,
      max_size: "10M",
      retain: 5
    },

    // ── Oceanside Partner Notifications (hourly, 7am–9pm, offset :30) ─────
    {
      name: "fc-oceanside-notify",
      script: "pipelines/partner_schedules/oceanside_ingest.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "30 7-21 * * *",
      autorestart: false,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "development"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/oceanside-notify-error.log",
      out_file: "logs/oceanside-notify-out.log",
      merge_logs: true,
      max_size: "10M",
      retain: 5
    }
  ]
};
