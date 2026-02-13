$ErrorActionPreference = "Stop"
Set-Location "C:\Users\kevin\.openclaw\workspace\fish_city_ingestion_clean"

# Force live pushes for scheduled runs
$env:DRY_RUN = "false"

npm run ingest:sd
npm run push:sd
