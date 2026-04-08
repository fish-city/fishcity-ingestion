#!/bin/bash
set -e
cd ~/openclaw/fishcity/workspaces/pm/fishcity-ingestion

echo "=== Fish City Ingestion — PM2 Setup ==="

# 1. Install PM2 globally if not already installed
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
else
  echo "PM2 already installed: $(pm2 --version)"
fi

# 2. Create logs directory
mkdir -p logs

# 3. Stop any existing FC processes
pm2 delete fc-report-ingestion fc-eldorado-notify fc-elpatron-notify fc-oceanside-notify 2>/dev/null || true

# 4. Clear stale state (fresh start)
echo "Clearing stale partner snapshots..."
rm -f state/eldorado_last_snapshot.json
rm -f state/elpatron_last_snapshot.json
rm -f state/oceanside_last_snapshot.json

# 5. Start all processes via ecosystem config
echo "Starting PM2 processes..."
pm2 start ecosystem.config.cjs

# 6. Save PM2 config so it survives reboots
pm2 save

# 7. Setup PM2 startup (auto-restart on reboot)
echo ""
echo "=== IMPORTANT ==="
echo "Run the command below to auto-start PM2 on reboot:"
echo "  pm2 startup"
echo "Then copy and run the command it prints."
echo ""

# 8. Show status
pm2 list

echo ""
echo "=== Schedule ==="
echo "Report Ingestion:  6am, 12pm, 6pm"
echo "El Dorado Notify:  7am, 11am, 3pm, 7pm"
echo "El Patron Notify:  7:15am, 11:15am, 3:15pm, 7:15pm"
echo "Oceanside Notify:  7:30am, 11:30am, 3:30pm, 7:30pm"
echo ""
echo "=== Quick Commands ==="
echo "  pm2 logs              — tail all logs"
echo "  pm2 logs fc-eldorado  — tail El Dorado logs"
echo "  pm2 trigger fc-eldorado-notify — manual trigger"
echo "  pm2 monit             — live dashboard"
echo "  pm2 list              — status overview"
echo ""
echo "=== To test El Dorado right now ==="
echo "  node pipelines/partner_schedules/eldorado_ingest.js"
