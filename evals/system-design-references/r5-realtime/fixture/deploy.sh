#!/usr/bin/env bash
set -euo pipefail
gcloud tasks queues create sections --location us-central1 || true
gcloud run deploy reports-service --source . --region us-central1 --allow-unauthenticated
