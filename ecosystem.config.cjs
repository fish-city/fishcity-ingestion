// PM2 Ecosystem Config — Fish City Ingestion Engine
// Run: pm2 start ecosystem.config.cjs
// Monitor: pm2 logs | pm2 monit
// Stop: pm2 stop all | pm2 delete all

module.exports = {
  apps: [
    // ── Fishing Report Ingestion (3x daily: 6am, 12pm, 6pm) ──────────────
    // Runs ingest.js first to collect fresh links, then push.js to submit them.
    {
      name: "fc-report-ingestion",
      script: "sh",
      args: "-c 'node pipelines/fishing_reports/ingest.js && node pipelines/fishing_reports/push.js'",
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

    // ── El Patron Partner Notifications (hourly, 7am–9pm) ─────────────────
    {
      name: "fc-elpatron-notify",
      script: "pipelines/partner_schedules/elpatron_ingest.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "0 7-21 * * *",
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

    // ── Black Pearl / Virg's Landing Notifications (hourly, 7am–9pm) ──────
    {
      name: "fc-blackpearl-notify",
      script: "pipelines/partner_schedules/blackpearl_ingest.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      cron_restart: "0 7-21 * * *",
      autorestart: false,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "development"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/blackpearl-notify-error.log",
      out_file: "logs/blackpearl-notify-out.log",
      merge_logs: true,
      max_size: "10M",
      retain: 5
    },

    // ── Dashboard (always-on, serves tracking UI + send log) ─────────────
    {
      name: "fc-dashboard",
      script: "dashboard/serve.js",
      cwd: "/Users/openclaw/openclaw/fishcity/workspaces/pm/fishcity-ingestion",
      autorestart: true,
      watch: false,
      max_memory_restart: "128M",
      env: {
        NODE_ENV: "development",
        DASHBOARD_PORT: "3847"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/dashboard-error.log",
      out_file: "logs/dashboard-out.log",
      merge_logs: true,
      max_size: "10M",
      retain: 3
    }
  ]
};
